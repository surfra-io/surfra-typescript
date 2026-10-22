// Calling apps and running jobs, for every runtime.

import { checked, credential, settingsFromEnv, sleep, SurfraFailure, type Settings } from "./core.js";

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
    const headers: Record<string, string> = { Authorization: `Bearer ${credential(this.settings)}` };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.settings.master}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return (await checked(response)).json();
  }

  /** Queue one call to an app and return it before the app finishes. */
  async enqueue(app: string, input: unknown = {}): Promise<Call> {
    const view = await this.call("POST", "/v1/transactions", { stages: [{ name: "call", app_name: app, depends_on: [], input }], metadata: {} });
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
