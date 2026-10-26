// Calling apps and running jobs, for every runtime.

import { anySignal, checked, controlCredential, guarded, REQUEST_TIMEOUT_MS, settingsFromEnv, signalFor, sleep, SurfraFailure, timeoutSignal, type RequestOptions, type Settings } from "./core.js";

export type { RequestOptions } from "./core.js";

/** Options for starting a transaction. */
export interface SubmitOptions extends RequestOptions {
  /** Surfra POSTs the task's latest state to this URL each time it changes. Check it with verifyWebhook. */
  callbackUrl?: string;
}

/** Options for waiting. `timeoutMs` bounds the whole wait, including a request in flight. */
export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A deadline for a whole wait: the caller's signal plus a timer, and a way to tell which one fired. */
function deadline({ signal, timeoutMs }: WaitOptions) {
  const timer = timeoutMs === undefined ? undefined : timeoutSignal(Math.max(0, timeoutMs));
  const ends = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  return {
    signal: anySignal([signal, timer]),
    remaining: () => (ends === Infinity ? undefined : Math.max(0, ends - Date.now())),
    passed: () => Date.now() >= ends,
    /** The error to throw: a SurfraFailure when our own timer ran out, else the error unchanged. */
    expired: (error: unknown, message: () => string) => (timer?.aborted && !signal?.aborted ? new SurfraFailure(message(), { cause: error }) : error),
  };
}

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

  /** The per-request limit from settings; 0 turns it off. */
  protected get requestTimeoutMs(): number {
    return this.settings.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** One control-plane request. `timeoutMs` replaces the per-request limit (default 60 s). */
  async call(method: string, route: string, json?: unknown, options: RequestOptions = {}): Promise<any> {
    const signal = signalFor(options, this.requestTimeoutMs);
    return guarded(signal, async () => {
      const headers: Record<string, string> = { Authorization: `Bearer ${controlCredential(this.settings)}` };
      if (json !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${this.settings.master}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal });
      return (await checked(response)).json();
    });
  }

  /**
   * Start a transaction. Over the organization's request rate, waits as Surfra asks, up to five times.
   * `timeoutMs` bounds the whole submit, waits included; each request also has the per-request limit.
   */
  async submit(stages: unknown[], metadata: Record<string, unknown> = {}, options: SubmitOptions = {}): Promise<any> {
    const payload: Record<string, unknown> = { stages, metadata };
    if (options.callbackUrl !== undefined) payload.callback_url = options.callbackUrl;
    const body = JSON.stringify(payload);
    const whole = signalFor(options);
    return guarded(whole, async () => {
      for (let attempt = 0; ; attempt++) {
        const signal = signalFor({ signal: whole }, this.requestTimeoutMs);
        const response = await guarded(signal, () =>
          fetch(`${this.settings.master}/v1/transactions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${controlCredential(this.settings)}`, "Content-Type": "application/json" },
            body,
            signal,
          }),
        );
        if (response.status !== 429 || attempt === RATE_RETRIES) return guarded(signal, async () => (await checked(response)).json());
        await response.body?.cancel();
        const wait = Math.min(60, Math.max(1, Number(response.headers.get("retry-after")) || 1));
        await sleep(wait * 1000, whole);
      }
    });
  }

  /** Queue one call to an app and return it before the app finishes. */
  async enqueue(app: string, input: unknown = {}, options: SubmitOptions = {}): Promise<Call> {
    const view = await this.submit([{ name: "call", app_name: app, depends_on: [], input }], {}, options);
    return new Call(this, view);
  }

  /** Call an app and wait for its output. `timeoutMs` bounds the whole run, submit included. */
  async run(app: string, input: unknown = {}, options: SubmitOptions = {}): Promise<any> {
    return runWith(options, `call to ${app}`, (signal) => this.enqueue(app, input, { signal, callbackUrl: options.callbackUrl }));
  }

  /** Run a command once on one machine. */
  async submitJob(job: JobSpec, options: RequestOptions = {}): Promise<Job> {
    return new Job(this, await this.call("POST", "/v1/jobs", job, options));
  }

  /** A job by id. */
  async job(id: string, options: RequestOptions = {}): Promise<Job> {
    return new Job(this, await this.call("GET", `/v1/jobs/${encodeURIComponent(id)}`, undefined, options));
  }
}

const RATE_RETRIES = 5;

/** Start a call with the run's deadline, then wait for it with what is left. */
async function runWith(options: WaitOptions, what: string, start: (signal?: AbortSignal) => Promise<Call>): Promise<any> {
  const limit = deadline(options);
  let call: Call;
  try {
    call = await start(limit.signal);
  } catch (error) {
    throw limit.expired(error, () => `${what} was not queued within ${options.timeoutMs} ms`);
  }
  return call.result({ signal: options.signal, timeoutMs: limit.remaining() });
}

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
  deploy(spec: AppSpec, options: RequestOptions = {}): Promise<any> {
    return this.client.call("PUT", this.route(), { env: {}, autoscale: {}, ...spec }, options);
  }

  /** The saved app: image, entrypoint, runtime and autoscale. */
  info(options: RequestOptions = {}): Promise<any> {
    return this.client.call("GET", this.route(), undefined, options);
  }

  /** Queue one request and return it before the app finishes. */
  enqueue(input: unknown = {}, options: SubmitOptions = {}): Promise<Call> {
    return this.client.enqueue(this.name, input, options);
  }

  /** Call the app and wait for its output. `timeoutMs` bounds the whole run. */
  run(input: unknown = {}, options: SubmitOptions = {}): Promise<any> {
    return this.client.run(this.name, input, options);
  }

  /** The volumes this app's replicas may reach, as [{ volume, mode }]. */
  async volumes(options: RequestOptions = {}): Promise<{ volume: string; mode: string }[]> {
    return (await this.client.call("GET", this.route("/volumes"), undefined, options)).volumes;
  }

  /** Replace the app's volumes, such as ["weights:r", "outputs:rw"]. */
  async setVolumes(volumes: string[], options: RequestOptions = {}): Promise<{ volume: string; mode: string }[]> {
    return (await this.client.call("PUT", this.route("/volumes"), { volumes }, options)).volumes;
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

  /** Save the stages, such as { name: "summarize", app: "summarize", depends: ["transcribe"] }. */
  deploy(stages: { name: string; app: string; depends?: string[] }[], options: RequestOptions = {}): Promise<any> {
    return this.client.call("PUT", `/v1/workflows/${encodeURIComponent(this.name)}`, {
      stages: stages.map((stage) => ({ depends: [], ...stage })),
    }, options);
  }

  /** Start one run. Stages with no dependencies receive input. `timeoutMs` bounds both requests together. */
  async enqueue(input: unknown = {}, options: SubmitOptions = {}): Promise<Call> {
    const signal = signalFor(options);
    return guarded(signal, async () => {
      const saved = await this.client.call("GET", `/v1/workflows/${encodeURIComponent(this.name)}`, undefined, { signal });
      const stages = (saved.stages ?? []).map((row: any) => {
        const depends = row.depends ?? [];
        return { name: row.name, app_name: row.app, depends_on: depends, input: depends.length ? {} : input };
      });
      return new Call(this.client, await this.client.submit(stages, { workflow: this.name }, { signal, callbackUrl: options.callbackUrl }));
    });
  }

  /** Start one run and wait. Returns { stage name: output }, or the output for a single stage. `timeoutMs` bounds the whole run. */
  async run(input: unknown = {}, options: SubmitOptions = {}): Promise<any> {
    return runWith(options, `workflow ${this.name}`, (signal) => this.enqueue(input, { signal, callbackUrl: options.callbackUrl }));
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

  async get(options: RequestOptions = {}): Promise<any> {
    this.view = await this.client.call("GET", `/v1/transactions/${encodeURIComponent(this.id)}`, undefined, options);
    return this.view;
  }

  /**
   * Wait for the call and return its output. A failed call throws with each stage's error.
   * When `timeoutMs` runs out, even mid-request, throws SurfraFailure; when `signal` aborts, its reason.
   */
  async result(options: WaitOptions = {}): Promise<any> {
    const limit = deadline(options);
    let wait = 100;
    try {
      while (!["succeeded", "failed"].includes((await this.get({ signal: limit.signal })).status)) {
        if (limit.passed()) throw new SurfraFailure(`call ${this.id} is still ${this.view.status}`);
        await sleep(wait, limit.signal);
        wait = Math.min(wait * 2, 2000);
      }
    } catch (error) {
      throw limit.expired(error, () => `call ${this.id} is still ${this.view.status}`);
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

  async get(options: RequestOptions = {}): Promise<any> {
    this.view = await this.client.call("GET", `/v1/jobs/${encodeURIComponent(this.id)}`, undefined, options);
    return this.view;
  }

  async stop(options: RequestOptions = {}): Promise<any> {
    this.view = await this.client.call("POST", `/v1/jobs/${encodeURIComponent(this.id)}/stop`, {}, options);
    return this.view;
  }

  /** The job's log lines after `after` (a timestamp from an earlier line), oldest first, as { t, s, m }. `timeoutMs` bounds every page together. */
  async logs({ after, ...options }: { after?: string } & RequestOptions = {}): Promise<{ t: string; s: string; m: string }[]> {
    const signal = signalFor(options);
    return guarded(signal, async () => {
      const out: { t: string; s: string; m: string }[] = [];
      let cursor = after;
      for (;;) {
        const query = new URLSearchParams({ limit: "1000", order: "asc" });
        if (cursor) query.set("after", cursor);
        const page = await this.client.call("GET", `/v1/jobs/${encodeURIComponent(this.id)}/logs?${query}`, undefined, { signal });
        const lines = page.lines ?? [];
        out.push(...lines);
        if (lines.length) cursor = lines[lines.length - 1].t;
        if (lines.length < 1000) return out;
      }
    });
  }

  /**
   * Wait until the job ends: succeeded, failed, stopped or lost.
   * When `timeoutMs` runs out, even mid-request, throws SurfraFailure; when `signal` aborts, its reason.
   */
  async wait({ intervalMs = 5000, ...options }: { intervalMs?: number } & WaitOptions = {}): Promise<any> {
    const limit = deadline(options);
    try {
      while (!ENDED.has((await this.get({ signal: limit.signal })).status)) {
        if (limit.passed()) throw new SurfraFailure(`job ${this.id} is still ${this.view.status}`);
        await sleep(intervalMs, limit.signal);
      }
    } catch (error) {
      throw limit.expired(error, () => `job ${this.id} is still ${this.view.status}`);
    }
    return this.view;
  }
}
