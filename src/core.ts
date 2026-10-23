// Settings, credentials and errors shared by every part of the SDK. Works in Node, Bun, Deno,
// Cloudflare Workers and browsers: nothing here touches the file system.

export const DEFAULT_MASTER = "https://api.surfra.io";
export const DEFAULT_VOLUMES = "https://volumes.surfra.io";
export const PART_BYTES = 64 * 1024 * 1024;

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
  constructor(message: string) {
    super(message);
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
