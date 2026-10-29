// Settings, credentials and errors shared by every part of the SDK. Works in Node, Bun, Deno,
// Cloudflare Workers and browsers: nothing here touches the file system.

/** This package's version. Sent as Surfra-Client so the control plane can trace errors to a release; a test keeps it equal to package.json. */
export const VERSION = "0.3.0";
export const DEFAULT_MASTER = "https://api.surfra.io";
export const DEFAULT_VOLUMES = "https://volumes.surfra.io";
export const PART_BYTES = 64 * 1024 * 1024;
/** How long one control-plane request may take before it is aborted with a TimeoutError. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** What the retry loop learned about a failed request. Every field is optional. */
export interface ErrorFacts {
  /** The HTTP status, when an answer came back. */
  status?: number;
  /** Surfra's `error.type`, such as `RATE_LIMITED`, `QUEUE_FULL`, `SERVER_BUSY`, `APP_PAUSED`, `DEFCON_ACTIVE` or `HTTP_CALLS_LIMIT` (402: the month's included HTTP calls are used up and there is no card on file). */
  type?: string;
  /** How many requests were made, retries included. */
  attempts?: number;
  /** A submission got a 504 or lost its connection after it was sent: the work may be running. */
  outcomeUnknown?: boolean;
  /** The wait Surfra asked for, in seconds (`Retry-After`, else `error.retry_after`). */
  retryAfter?: number;
}

/**
 * Surfra refused a request. `status` is the HTTP code, `detail` the reason it gave, `type` Surfra's
 * `error.type` when the answer had one, `attempts` how many requests were made, and `outcomeUnknown`
 * whether a submission may be running even though this was thrown.
 */
export class SurfraError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly type: string | undefined;
  attempts: number;
  outcomeUnknown: boolean;
  readonly retryAfter: number | undefined;
  constructor(status: number, detail: string, facts: Omit<ErrorFacts, "status"> & { note?: string } = {}) {
    super(facts.note ? `${status}: ${detail} (${facts.note})` : `${status}: ${detail}`);
    this.name = "SurfraError";
    this.status = status;
    this.detail = detail;
    this.type = facts.type;
    this.attempts = facts.attempts ?? 1;
    this.outcomeUnknown = facts.outcomeUnknown ?? false;
    this.retryAfter = facts.retryAfter;
  }
}

/**
 * No credential was found, a call or job did not finish as hoped, or the connection failed (then `cause` is
 * the network error, `attempts` how many requests were made, and `outcomeUnknown` whether a submission may
 * be running anyway).
 */
export class SurfraFailure extends Error {
  readonly status: number | undefined;
  readonly type: string | undefined;
  attempts: number | undefined;
  outcomeUnknown: boolean;
  readonly retryAfter: number | undefined;
  constructor(message: string, options?: { cause?: unknown } & ErrorFacts) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SurfraFailure";
    this.status = options?.status;
    this.type = options?.type;
    this.attempts = options?.attempts;
    this.outcomeUnknown = options?.outcomeUnknown ?? false;
    this.retryAfter = options?.retryAfter;
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
  /**
   * Retries after the first attempt, default 7 (8 attempts in all). `0` turns retries off. Which answers are
   * retried is fixed (see the README, "Errors and retries"); this only bounds how often.
   */
  maxRetries?: number;
  /** No retry wait may end later than this many ms after the first attempt, default 180 000 (3 minutes). */
  retryDeadlineMs?: number;
  /** Told about every retry before its wait. Exceptions it throws are ignored. */
  onRetry?: (event: RetryEvent) => void;
  /** `SURFRA_DEBUG=1`: also print every retry with console.warn. */
  debug?: boolean;
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
    debug: ["1", "true", "yes"].includes((read(env, "SURFRA_DEBUG") ?? "").toLowerCase()) || undefined,
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

interface ErrorBody {
  detail: string;
  type?: string;
  retryAfter?: number;
}

/** The reason in a failed answer: {"detail", "error": {"type", "message", "retry_after"}}, the older {"error": "..."}, or the text. */
function parseErrorBody(text: string, fallback: string): ErrorBody {
  try {
    const body = JSON.parse(text);
    const error = body?.error;
    if (typeof error === "string") return { detail: error };
    const detail = typeof body?.detail === "string" ? body.detail : typeof error?.message === "string" ? error.message : text || fallback;
    if (error && typeof error === "object" && typeof error.type === "string") {
      const after = Number(error.retry_after);
      return { detail, type: error.type, retryAfter: error.retry_after != null && Number.isFinite(after) && after >= 0 ? after : undefined };
    }
    return { detail };
  } catch {
    return { detail: text || fallback };
  }
}

/** Throw SurfraError for a non-success response, reading {"error": ...} or {"detail": ...}. */
export async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  const body = parseErrorBody(text, response.statusText);
  throw new SurfraError(response.status, body.detail, { type: body.type, retryAfter: retryAfterHeader(response) ?? body.retryAfter });
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
export interface RequestOptions extends RetryOptions {
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

// Retries ------------------------------------------------------------------------------------------
//
// One loop for every control-plane and volume request, following the shared contract
// (surfra-sdk-tests/CASES.md, "Retries"):
//
//   429, or error.type RATE_LIMITED / QUEUE_FULL / SERVER_BUSY   retry, every method
//   error.type APP_PAUSED / DEFCON_ACTIVE                          never
//   502 / 503 / 504 with no Surfra error body (no error.type)     GET and HEAD only
//   a connection that never reached the server                    retry, every method
//   a connection lost after the request was sent                  GET and HEAD only
//   anything else                                                  never
//
// A submission (POST of a transaction or job) that gets a plain 504 or loses its connection after it
// was sent may be running: it is not retried, and the error has outcomeUnknown set.

/** Retries after the first attempt, by default. */
export const MAX_RETRIES = 7;
/** No retry wait may end later than this long after the first attempt, by default. */
export const RETRY_DEADLINE_MS = 180_000;
/** The longest backoff wait when Surfra did not say how long to wait. */
const BACKOFF_CAP_MS = 30_000;
const BACKOFF_BASE_MS = 500;

/** One retry, reported to `onRetry` before its wait. */
export interface RetryEvent {
  /** The attempt that just failed, from 1. */
  attempt: number;
  /** How long the SDK waits before the next attempt. */
  delayMs: number;
  /** The HTTP status, when an answer came back. */
  status?: number;
  /** Surfra's `error.type`, when the answer had one. */
  type?: string;
  /** Why it is retried, such as "429 RATE_LIMITED" or "connection refused (ECONNREFUSED)". */
  reason: string;
  method: string;
  url: string;
}

/** Per-call retry limits, on top of the client's settings. */
export interface RetryOptions {
  /** Retries after the first attempt for this call; `0` turns them off. */
  maxRetries?: number;
  /** No retry wait may end later than this many ms after the first attempt. */
  retryDeadlineMs?: number;
  /** Told about this call's retries, in place of the client's `onRetry`. */
  onRetry?: (event: RetryEvent) => void;
}

const RETRY_ANY = new Set(["RATE_LIMITED", "QUEUE_FULL", "SERVER_BUSY"]);
const RETRY_NEVER = new Set(["APP_PAUSED", "DEFCON_ACTIVE", "HTTP_CALLS_LIMIT"]);
const EDGE_STATUSES = new Set([502, 503, 504]);
/** Error codes that mean the request never left this machine: no connection was made. */
const NOT_SENT = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "ConnectionRefused", "FailedToOpenSocket",
]);

/** The codes on a network error and its causes (Node's fetch wraps them in TypeError, sometimes AggregateError). */
function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 4) return [];
  const found: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") found.push(code);
  for (const inner of (error as { errors?: unknown[] }).errors ?? []) found.push(...errorCodes(inner, depth + 1));
  found.push(...errorCodes((error as { cause?: unknown }).cause, depth + 1));
  return found;
}

/**
 * Whether a fetch error means the request never reached the server. Only a connect-stage code counts:
 * a reset, a closed socket or an error with no code may come after the request was sent.
 */
export function neverSent(error: unknown): boolean {
  const codes = errorCodes(error);
  return codes.length > 0 && codes.every((code) => NOT_SENT.has(code));
}

/** `Retry-After` in seconds: a number, or an HTTP date. */
export function retryAfterHeader(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, (when - Date.now()) / 1000);
}

/** One HTTP request to send, maybe more than once. The body must be reusable (not a stream). */
export interface Outgoing {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

/** How to send it. */
export interface RetryContext {
  settings: Settings;
  /** The caller's per-call options: retry limits and hook. Its signal and timeoutMs are not read here. */
  options?: RetryOptions;
  /** Cancels the whole request, retries and waits included. */
  signal?: AbortSignal;
  /** A limit for each attempt; 0 or undefined for none. When it runs out the TimeoutError is thrown, not retried. */
  perAttemptMs?: number;
  /** A submission: a POST that starts work (a transaction or a job). */
  submission?: boolean;
  /** Non-success answers to hand back instead of throwing, such as a 404 the caller handles. */
  accept?: (response: Response) => boolean;
}

interface Verdict {
  retry: boolean;
  reason: string;
  error: Error;
  retryAfter?: number;
}

const MAY_BE_RUNNING =
  "the submission may have been received and may be running, so it was not retried; check for it before submitting again " +
  "(Call.get / Client.job), and for long work prefer enqueue + result or a callbackUrl";

function describe(error: unknown): string {
  const code = errorCodes(error)[0];
  const message = (error as { cause?: { message?: string } })?.cause?.message ?? (error as Error)?.message ?? String(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

function judgeAnswer(response: Response, body: ErrorBody, method: string, ctx: RetryContext, attempts: number): Verdict {
  const status = response.status;
  const idempotent = method === "GET" || method === "HEAD";
  const retryAfter = retryAfterHeader(response) ?? body.retryAfter;
  const type = body.type;
  let retry = false;
  let outcomeUnknown = false;
  if (type !== undefined) retry = !RETRY_NEVER.has(type) && (RETRY_ANY.has(type) || status === 429);
  else if (status === 429) retry = true;
  else if (EDGE_STATUSES.has(status)) {
    retry = idempotent;
    outcomeUnknown = status === 504 && !idempotent;
  }
  const note = outcomeUnknown ? (ctx.submission ? `outcome unknown: ${MAY_BE_RUNNING}` : "outcome unknown: the request may have been applied") : undefined;
  const error = new SurfraError(status, body.detail, { type, attempts, outcomeUnknown, retryAfter, note });
  return { retry, reason: type ? `${status} ${type}` : String(status), error, retryAfter };
}

function judgeNetwork(failure: unknown, outgoing: Outgoing, ctx: RetryContext, attempts: number): Verdict {
  const method = outgoing.method;
  const idempotent = method === "GET" || method === "HEAD";
  const where = `${method} ${new URL(String(outgoing.url)).pathname}`;
  if (neverSent(failure)) {
    const reason = `connection failed before the request was sent: ${describe(failure)}`;
    return { retry: true, reason, error: new SurfraFailure(`${where}: ${reason}`, { cause: failure, attempts }) };
  }
  const reason = `connection lost, the request may have been sent: ${describe(failure)}`;
  const outcomeUnknown = !idempotent;
  const note = !outcomeUnknown ? "" : ctx.submission ? `; outcome unknown: ${MAY_BE_RUNNING}` : "; outcome unknown: the request may have been applied, so it was not retried";
  return { retry: idempotent, reason, error: new SurfraFailure(`${where}: ${reason}${note}`, { cause: failure, attempts, outcomeUnknown }) };
}

function report(ctx: RetryContext, event: RetryEvent): void {
  const hook = ctx.options?.onRetry ?? ctx.settings.onRetry;
  try {
    hook?.(event);
  } catch {
    // A hook must not change what the request does.
  }
  if (ctx.settings.debug) {
    console.warn(`surfra: ${event.method} ${event.url}: attempt ${event.attempt} failed (${event.reason}); retrying in ${Math.round(event.delayMs)} ms`);
  }
}

/**
 * Send a request, retrying as the contract says. Returns a success response, or one `accept` takes;
 * otherwise throws SurfraError (an answer) or SurfraFailure (a network error) with the attempts made.
 * Aborts by `signal` reject with its reason at once, mid-request or mid-wait.
 */
export async function sendWithRetry(outgoing: Outgoing, ctx: RetryContext): Promise<Response> {
  const { signal } = ctx;
  const maxRetries = Math.max(0, ctx.options?.maxRetries ?? ctx.settings.maxRetries ?? MAX_RETRIES);
  const deadlineMs = ctx.options?.retryDeadlineMs ?? ctx.settings.retryDeadlineMs ?? RETRY_DEADLINE_MS;
  const method = outgoing.method.toUpperCase();
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    const attemptSignal = anySignal([signal, ctx.perAttemptMs ? timeoutSignal(ctx.perAttemptMs) : undefined]);
    let verdict: Verdict;
    try {
      const response = await fetch(outgoing.url, { method, headers: { ...outgoing.headers, "Surfra-Client": `surfra-typescript/${VERSION}` }, body: outgoing.body, signal: attemptSignal });
      if (response.ok || ctx.accept?.(response)) return response;
      const text = await response.text().catch(() => "");
      if (attemptSignal?.aborted) throw abortReason(attemptSignal);
      verdict = judgeAnswer(response, parseErrorBody(text, response.statusText), method, ctx, attempt);
    } catch (failure) {
      if (signal?.aborted) throw abortReason(signal);
      // The per-attempt limit ran out: the caller's bound, not a fault to retry.
      if (attemptSignal?.aborted) throw abortReason(attemptSignal);
      verdict = judgeNetwork(failure, outgoing, ctx, attempt);
    }
    if (!verdict.retry || attempt > maxRetries) throw verdict.error;
    const delayMs = verdict.retryAfter !== undefined ? verdict.retryAfter * 1000 : Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    if (Date.now() + delayMs - started > deadlineMs) throw verdict.error;
    const status = verdict.error instanceof SurfraError ? verdict.error.status : undefined;
    const type = verdict.error instanceof SurfraError ? verdict.error.type : undefined;
    report(ctx, { attempt, delayMs, status, type, reason: verdict.reason, method, url: String(outgoing.url) });
    await sleep(delayMs, signal);
  }
}

/**
 * One JSON request to the control plane, with retries. `timeoutMs` bounds the whole call, retries included,
 * and replaces the per-attempt limit unless `keepAttemptLimit` (as `submit` always did).
 */
export async function controlRequest(
  settings: Settings,
  method: string,
  route: string,
  json: unknown,
  options: RequestOptions = {},
  { submission = false, keepAttemptLimit = false }: { submission?: boolean; keepAttemptLimit?: boolean } = {},
): Promise<any> {
  const signal = signalFor({ signal: options.signal, timeoutMs: options.timeoutMs });
  const perAttemptMs = options.timeoutMs !== undefined && !keepAttemptLimit ? 0 : settings.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return guarded(signal, async () => {
    const headers: Record<string, string> = { Authorization: `Bearer ${controlCredential(settings)}` };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const body = json === undefined ? undefined : JSON.stringify(json);
    const response = await sendWithRetry({ method, url: `${settings.master}${route}`, headers, body }, { settings, options, signal, perAttemptMs, submission });
    return response.json();
  });
}
