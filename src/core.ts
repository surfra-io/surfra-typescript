// Settings, credentials and errors shared by every part of the SDK. Works in Node, Bun, Deno,
// Cloudflare Workers and browsers: nothing here touches the file system.

export const DEFAULT_MASTER = "https://api.surfra.io";
export const DEFAULT_VOLUMES = "https://volumes.surfra.io";
export const PART_BYTES = 64 * 1024 * 1024;
/** How long one control-plane request may take before it is aborted with a TimeoutError. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Surfra refused a request. `status` is the HTTP code, `detail` the reason it gave. */
export class SurfraError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`);
    this.name = "SurfraError";
    this.status = status;
    this.detail = detail;
  }
}

/** No credential was found, or a call or job did not finish as hoped. */
export class SurfraFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SurfraFailure";
  }
}

export interface Settings {
  /** Sent before anything else when set. */
  apiKey?: string;
  /** The control plane. `SURFRA_MASTER`, default https://api.surfra.io. */
  master: string;
  /** The volumes service. `SURFRA_VOLUMES_URL`, default https://volumes.surfra.io. Inside a Surfra app or job, a local proxy that adds the credential. */
  volumesUrl: string;
  /** The largest single upload; larger files go in parts. `SURFRA_VOLUMES_PART_BYTES`, default 64 MiB. */
  partBytes: number;
  /**
   * The longest one control-plane request may take, in milliseconds, default 60 000. A request that
   * takes longer is aborted with a `TimeoutError`. `0` turns it off. Volume transfers have no default
   * limit: pass `timeoutMs` or a `signal` to bound them.
   */
  requestTimeoutMs?: number;
  /** `SURFRA_API_KEY`. */
  envApiKey?: string;
  /** `SURFRA_REPLICA_TOKEN`. */
  replicaToken?: string;
  /** Reads the volumes token Surfra gives apps and jobs. Set by the Node build from `SURFRA_VOLUMES_TOKEN_FILE`. */
  readTokenFile?: () => string | undefined;
  /** Reads the session `surfra login` saved. Set by the Node build. */
  readLogin?: () => string | undefined;
}

type Env = Record<string, string | undefined>;

export function processEnv(): Env {
  const found = (globalThis as { process?: { env?: Env } }).process?.env;
  return found ?? {};
}

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Settings from `SURFRA_*` variables where the runtime has them, else Surfra's defaults. */
export function settingsFromEnv(env: Env = processEnv()): Settings {
  return {
    master: (read(env, "SURFRA_MASTER") ?? DEFAULT_MASTER).replace(/\/+$/, ""),
    volumesUrl: (read(env, "SURFRA_VOLUMES_URL") ?? DEFAULT_VOLUMES).replace(/\/+$/, ""),
    partBytes: Number(read(env, "SURFRA_VOLUMES_PART_BYTES") ?? PART_BYTES),
    envApiKey: read(env, "SURFRA_API_KEY"),
    replicaToken: read(env, "SURFRA_REPLICA_TOKEN"),
  };
}

/** The credential to send, in Surfra's order: explicit key, token file, SURFRA_API_KEY, SURFRA_REPLICA_TOKEN, saved login. */
export function credential(settings: Settings): string {
  const found = settings.apiKey || settings.readTokenFile?.() || settings.envApiKey || settings.replicaToken || settings.readLogin?.();
  if (found) return found;
  throw new SurfraFailure("no credential: set SURFRA_API_KEY or run `surfra login`");
}

/** The credential for control-plane calls: never the volumes token, which only the volumes service accepts. */
export function controlCredential(settings: Settings): string {
  const found = settings.apiKey || settings.envApiKey || settings.readLogin?.();
  if (found) return found;
  throw new SurfraFailure("no credential: set SURFRA_API_KEY or run `surfra login`");
}

/** Throw SurfraError for a non-success response, reading {"error": ...} or {"detail": ...}. */
export async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  let detail = text || response.statusText;
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === "string") detail = body.error;
    else if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    // Not JSON: keep the text.
  }
  throw new SurfraError(response.status, detail);
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Options every network method takes, alongside its own. `signal` cancels the call; `timeoutMs` bounds it,
 * including retries, polling and any request in flight. A cancelled call rejects with the signal's reason:
 * an `AbortError` from `AbortController.abort()`, a `TimeoutError` when `timeoutMs` (or the per-request
 * limit) runs out. `Call.result`, `run` and `Job.wait` keep their `SurfraFailure` when `timeoutMs` runs out.
 */
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** A signal that aborts with a `TimeoutError` after ms. */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer: any = setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
  timer?.unref?.();
  return controller.signal;
}

/** @internal AbortSignal.any for runtimes that lack it (Node before 18.17 and 20.3, older browsers). */
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const found = signals.find((signal) => signal.aborted);
  if (found) {
    controller.abort(abortReason(found));
    return controller.signal;
  }
  const onAbort = (event: Event) => {
    for (const signal of signals) signal.removeEventListener("abort", onAbort);
    controller.abort(abortReason(event.target as AbortSignal));
  };
  for (const signal of signals) signal.addEventListener("abort", onAbort);
  return controller.signal;
}

/** One signal that aborts when any of these does. */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) return present[0];
  const native = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof native === "function" ? native.call(AbortSignal, present) : combineSignals(present);
}

/** The signal for one call: the caller's signal, plus timeoutMs (or fallbackMs) when set. `0` means no limit. */
export function signalFor({ signal, timeoutMs }: RequestOptions = {}, fallbackMs?: number): AbortSignal | undefined {
  const ms = timeoutMs ?? fallbackMs;
  return anySignal([signal, ms ? timeoutSignal(ms) : undefined]);
}

/** Run work; if signal aborted meanwhile, reject with its reason, so the AbortError or TimeoutError name survives. */
export async function guarded<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
}

/** Wait ms, or reject with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
