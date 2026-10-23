// Calling apps and running jobs, for every runtime.

import { checked, controlCredential, settingsFromEnv, sleep, SurfraFailure, type Settings } from "./core.js";

export interface JobSpec {
  entrypoint?: string;
  image?: string;
  spec?: string;
  args?: string[];
  /** Machine rows in order, such as { provider: "runpod", gpu: "rtx4090" }. */
  providers?: Record<string, unknown>[];
  env?: Record<string, string>;
  /** Volumes the job may reach, such as "weights:r". Missing volumes are created. */
  volumes?: string[];
  name?: string;
  deadline_sec?: number;
}

const ENDED = new Set(["succeeded", "failed", "stopped", "lost"]);

/** The control plane: call apps and run jobs. */
export class Client {
  protected readonly settings: Settings;

  constructor(settings: Partial<Settings> = {}) {
    this.settings = { ...settingsFromEnv(), ...settings };
  }

  async call(method: string, route: string, json?: unknown): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${controlCredential(this.settings)}` };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.settings.master}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return (await checked(response)).json();
  }

  /** Start a transaction. Over the organization's request rate, waits as Surfra asks, up to five times. */
  async submit(stages: unknown[], metadata: Record<string, unknown> = {}): Promise<any> {
    const body = JSON.stringify({ stages, metadata });
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.settings.master}/v1/transactions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${controlCredential(this.settings)}`, "Content-Type": "application/json" },
        body,
      });
      if (response.status !== 429 || attempt === RATE_RETRIES) return (await checked(response)).json();
      await response.body?.cancel();
      const wait = Math.min(60, Math.max(1, Number(response.headers.get("retry-after")) || 1));
      await sleep(wait * 1000);
    }
  }

  /** Queue one call to an app and return it before the app finishes. */
  async enqueue(app: string, input: unknown = {}): Promise<Call> {
    const view = await this.submit([{ name: "call", app_name: app, depends_on: [], input }]);
    return new Call(this, view);
  }

  /** Call an app and wait for its output. */
  async run(app: string, input: unknown = {}, { timeoutMs }: { timeoutMs?: number } = {}): Promise<any> {
    return (await this.enqueue(app, input)).result({ timeoutMs });
  }

  /** Run a command once on one machine. */
  async submitJob(job: JobSpec): Promise<Job> {
    return new Job(this, await this.call("POST", "/v1/jobs", job));
  }

  /** A job by id. */
  async job(id: string): Promise<Job> {
    return new Job(this, await this.call("GET", `/v1/jobs/${encodeURIComponent(id)}`));
  }
}

const RATE_RETRIES = 5;

/** What an app runs, for App.deploy. runtime is { engine: "python" } or { engine: "http", port: 8000 }. */
export interface AppSpec {
  image: string;
  entrypoint: string;
  env?: Record<string, string>;
  /** Machine rows, replicas and scaling, as in the docs' autoscale reference. */
  autoscale?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  registry?: Record<string, unknown>;
}

/** A deployed app by name. No request is made until it is used. */
export class App {
  readonly name: string;
  protected readonly client: Client;

  constructor(name: string, settings: Partial<Settings> = {}) {
    this.name = name;
    this.client = new Client(settings);
  }

  private route(rest = ""): string {
    return `/v1/apps/${encodeURIComponent(this.name)}${rest}`;
  }

  /** Create the app, or update the app with this name. Returns the saved app with its sfa_ id. */
  deploy(spec: AppSpec): Promise<any> {
    return this.client.call("PUT", this.route(), { env: {}, autoscale: {}, ...spec });
  }

  /** The saved app: image, entrypoint, runtime and autoscale. */
  info(): Promise<any> {
    return this.client.call("GET", this.route());
  }

  /** Queue one request and return it before the app finishes. */
  enqueue(input: unknown = {}): Promise<Call> {
    return this.client.enqueue(this.name, input);
  }

  /** Call the app and wait for its output. */
  run(input: unknown = {}, options: { timeoutMs?: number } = {}): Promise<any> {
    return this.client.run(this.name, input, options);
  }

  /** The volumes this app's replicas may reach, as [{ volume, mode }]. */
  async volumes(): Promise<{ volume: string; mode: string }[]> {
    return (await this.client.call("GET", this.route("/volumes"))).volumes;
  }

  /** Replace the app's volumes, such as ["weights:r", "outputs:rw"]. */
  async setVolumes(volumes: string[]): Promise<{ volume: string; mode: string }[]> {
    return (await this.client.call("PUT", this.route("/volumes"), { volumes })).volumes;
  }
}

/** A saved workflow by name. */
export class Workflow {
  readonly name: string;
  protected readonly client: Client;

  constructor(name: string, settings: Partial<Settings> = {}) {
    this.name = name;
    this.client = new Client(settings);
  }

  /** Start one run. Stages with no dependencies receive input. */
  async enqueue(input: unknown = {}): Promise<Call> {
    const saved = await this.client.call("GET", `/v1/workflows/${encodeURIComponent(this.name)}`);
    const stages = (saved.stages ?? []).map((row: any) => {
      const depends = row.depends ?? [];
      return { name: row.name, app_name: row.app, depends_on: depends, input: depends.length ? {} : input };
    });
    return new Call(this.client, await this.client.submit(stages, { workflow: this.name }));
  }

  /** Start one run and wait. Returns { stage name: output }, or the output for a single stage. */
  async run(input: unknown = {}, options: { timeoutMs?: number } = {}): Promise<any> {
    return (await this.enqueue(input)).result(options);
  }
}

/** One call to an app. */
export class Call {
  readonly id: string;
  view: any;
  constructor(private readonly client: Client, view: any) {
    this.view = view;
    this.id = view.id;
  }

  async get(): Promise<any> {
    this.view = await this.client.call("GET", `/v1/transactions/${encodeURIComponent(this.id)}`);
    return this.view;
  }

  /** Wait for the call and return its output. A failed call throws with each stage's error. */
  async result({ timeoutMs }: { timeoutMs?: number } = {}): Promise<any> {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    let wait = 100;
    while (!["succeeded", "failed"].includes((await this.get()).status)) {
      if (Date.now() >= deadline) throw new SurfraFailure(`call ${this.id} is still ${this.view.status}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 2000);
    }
    const stages: any[] = this.view.stages ?? [];
    if (this.view.status !== "succeeded") {
      throw new SurfraFailure(stages.map((stage) => `${stage.name}: ${stage.output?.error ?? "failed"}`).join("; "));
    }
    if (stages.length === 1) return stages[0].output;
    return Object.fromEntries(stages.map((stage) => [stage.name, stage.output]));
  }
}

/** One job. */
export class Job {
  readonly id: string;
  view: any;
  constructor(private readonly client: Client, view: any) {
    this.view = view;
    this.id = view.id;
  }

  get status(): string {
    return this.view.status;
  }

  async get(): Promise<any> {
    this.view = await this.client.call("GET", `/v1/jobs/${encodeURIComponent(this.id)}`);
    return this.view;
  }

  async stop(): Promise<any> {
    this.view = await this.client.call("POST", `/v1/jobs/${encodeURIComponent(this.id)}/stop`, {});
    return this.view;
  }

  /** The job's log lines after `after` (a timestamp from an earlier line), oldest first, as { t, s, m }. */
  async logs({ after }: { after?: string } = {}): Promise<{ t: string; s: string; m: string }[]> {
    const out: { t: string; s: string; m: string }[] = [];
    let cursor = after;
    for (;;) {
      const query = new URLSearchParams({ limit: "1000", order: "asc" });
      if (cursor) query.set("after", cursor);
      const page = await this.client.call("GET", `/v1/jobs/${encodeURIComponent(this.id)}/logs?${query}`);
      const lines = page.lines ?? [];
      out.push(...lines);
      if (lines.length) cursor = lines[lines.length - 1].t;
      if (lines.length < 1000) return out;
    }
  }

  /** Wait until the job ends: succeeded, failed, stopped or lost. */
  async wait({ intervalMs = 5000, timeoutMs }: { intervalMs?: number; timeoutMs?: number } = {}): Promise<any> {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    while (!ENDED.has((await this.get()).status)) {
      if (Date.now() >= deadline) throw new SurfraFailure(`job ${this.id} is still ${this.view.status}`);
      await sleep(intervalMs);
    }
    return this.view;
  }
}
