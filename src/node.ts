// The Surfra SDK for Node: the same API as index.ts, plus local sync, commit, and file uploads.
//
//   import { Volume } from "surfra";
//   const dir = await new Volume("weights").path("minilm/").local();   // a real folder on local disk
//
// The sync cache layout is shared with every Surfra SDK, so Node and Python code in one container agree.

import { webcrypto } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as nodePath from "node:path";
import { Readable } from "node:stream";

import { App as BaseApp, Client as BaseClient, Workflow as BaseWorkflow } from "./client.js";
import { processEnv, settingsFromEnv, signalFor, SurfraError, type RequestOptions, type Settings } from "./core.js";
import { Volume as BaseVolume, type Entry, type Mode } from "./volume.js";
import { useSubtleCrypto } from "./webhooks.js";

export { Call, Job, type AppSpec, type JobSpec, type SubmitOptions, type WaitOptions } from "./client.js";
export { SurfraError, SurfraFailure, type RequestOptions, type Settings } from "./core.js";
export type { Entry, Mode, Body } from "./volume.js";
export { verifyWebhook, WebhookVerificationError, type CallbackPayload, type VerifyWebhookOptions } from "./webhooks.js";

useSubtleCrypto(webcrypto.subtle as SubtleCrypto);

const DOWNLOADS = 8;

export interface NodeSettings extends Settings {
  /** Where local() keeps synced files. `SURFRA_VOLUME_CACHE`, default <temp dir>/surfra. */
  cache: string;
  /** `SURFRA_VOLUMES_TOKEN_FILE`. Re-read when it changes, so a rotated token is picked up. */
  tokenFile?: string;
  /** The session `surfra login` saved. */
  loginFile?: string;
  /**
   * How long a credential file read is trusted before the file is checked again, default 1000 ms.
   * After that, a stat; the file is read again only when its mtime or size changed.
   */
  credentialCacheMs?: number;
}

const CREDENTIAL_CACHE_MS = 1000;

interface Cached {
  text: string | undefined;
  checked: number;
  stamp: string | undefined;
}

function stamp(path: string): string | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/** A reader of one file that reads it only when it may have changed: a stat at most every ttlMs, a read when the stat differs. */
function cachedReader(path: () => string | undefined, ttlMs: () => number): () => string | undefined {
  let cached: (Cached & { path: string }) | undefined;
  return () => {
    const file = path();
    if (!file) return undefined;
    const now = Date.now();
    if (cached && cached.path === file && now - cached.checked < ttlMs()) return cached.text;
    const current = stamp(file);
    if (!cached || cached.path !== file || current !== cached.stamp) {
      let text: string | undefined;
      try {
        text = current === undefined ? undefined : readFileSync(file, "utf8");
      } catch {
        text = undefined;
      }
      cached = { path: file, text, checked: now, stamp: current };
    } else {
      cached.checked = now;
    }
    return cached.text;
  };
}

/** Node settings from the environment: everything in Settings, plus the cache and file credentials. */
export function nodeSettingsFromEnv(overrides: Partial<NodeSettings> = {}): NodeSettings {
  const env = processEnv();
  const base: NodeSettings = {
    ...settingsFromEnv(env),
    cache: env.SURFRA_VOLUME_CACHE?.trim() || nodePath.join(tmpdir(), "surfra"),
    tokenFile: env.SURFRA_VOLUMES_TOKEN_FILE?.trim() || undefined,
    loginFile: nodePath.join(homedir(), ".surfra", "config.json"),
    ...overrides,
  };
  const ttl = () => base.credentialCacheMs ?? CREDENTIAL_CACHE_MS;
  const tokenText = cachedReader(() => base.tokenFile, ttl);
  const loginText = cachedReader(() => base.loginFile, ttl);
  base.readTokenFile = () => tokenText()?.trim() || undefined;
  base.readLogin = () => {
    const text = loginText();
    try {
      return text ? JSON.parse(text).token : undefined;
    } catch {
      return undefined;
    }
  };
  return base;
}

/** The control plane, with Node's credential sources. */
export class Client extends BaseClient {
  constructor(settings: Partial<NodeSettings> = {}) {
    super(nodeSettingsFromEnv(settings));
  }
}

/** A deployed app by name, with Node's credential sources. */
export class App extends BaseApp {
  constructor(name: string, settings: Partial<NodeSettings> = {}) {
    super(name, nodeSettingsFromEnv(settings));
  }
}

/** A saved workflow by name, with Node's credential sources. */
export class Workflow extends BaseWorkflow {
  constructor(name: string, settings: Partial<NodeSettings> = {}) {
    super(name, nodeSettingsFromEnv(settings));
  }
}

interface Known {
  etag: string;
  size: number;
  mtime_ns: bigint;
}
type State = Map<string, Known>;

// mtime_ns is nanoseconds, past what a JavaScript number holds exactly, so it is read and written as a BigInt.
function parseState(text: string): State {
  const quoted = text.replace(/"mtime_ns"\s*:\s*(\d+)/g, '"mtime_ns":"$1"');
  const raw = JSON.parse(quoted) as Record<string, { etag: string; size: number; mtime_ns?: string }>;
  return new Map(Object.entries(raw).map(([key, value]) => [key, { etag: value.etag, size: value.size, mtime_ns: BigInt(value.mtime_ns ?? "0") }]));
}

function stringifyState(state: State): string {
  const body = Object.fromEntries([...state].map(([key, value]) => [key, { etag: value.etag, size: value.size, mtime_ns: `@@${value.mtime_ns}@@` }]));
  return JSON.stringify(body).replace(/"@@(\d+)@@"/g, "$1");
}

async function mtimeNs(path: string): Promise<{ size: number; mtime_ns: bigint } | undefined> {
  try {
    const stat = await fs.stat(path, { bigint: true });
    return stat.isFile() ? { size: Number(stat.size), mtime_ns: stat.mtimeNs } : undefined;
  } catch {
    return undefined;
  }
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = nodePath.join(dir, item.name);
    if (item.isDirectory()) await walk(full, out);
    else if (item.isFile()) out.push(full);
  }
  return out;
}

async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

const isFolder = (path: string) => path === "" || path.endsWith("/");

/** A file or folder inside a volume. A trailing slash means a folder. */
export class VolumePath {
  constructor(readonly volume: Volume, readonly path: string) {}

  /** Download this piece into the local cache and return its real path. */
  local({ mode = "r", refresh = false, ...options }: { mode?: Mode; refresh?: boolean } & RequestOptions = {}): Promise<string> {
    return this.volume.sync(this.path, mode, refresh, options);
  }

  /** A plain copy into dest, outside the sync cache. `timeoutMs` bounds the whole copy. */
  async download(dest: string, options: RequestOptions = {}): Promise<string> {
    const signal = signalFor(options);
    if (isFolder(this.path)) {
      for (const entry of await this.volume.ls(this.path, { recursive: true, signal })) {
        await this.volume.downloadTo(entry.path, nodePath.join(dest, entry.path.slice(this.path.length)), { signal });
      }
    } else {
      const isDir = await fs.stat(dest).then((stat) => stat.isDirectory()).catch(() => false);
      await this.volume.downloadTo(this.path, isDir ? nodePath.join(dest, nodePath.basename(this.path)) : dest, { signal });
    }
    return dest;
  }
}

/** A volume, with local sync. */
export class Volume extends BaseVolume {
  private readonly synced = new Map<string, Mode>();
  private lock: Promise<unknown> = Promise.resolve();
  protected declare readonly settings: NodeSettings;

  constructor(name: string, settings: Partial<NodeSettings> = {}) {
    super(name, nodeSettingsFromEnv(settings));
  }

  path(path: string): VolumePath {
    return new VolumePath(this, path.replace(/^\/+/, ""));
  }

  /** Upload one local file. Files over the part size go up in parts, read a part at a time. */
  async putFile(local: string, remote: string, options: RequestOptions = {}): Promise<Entry> {
    const signal = signalFor(options);
    const { size } = await fs.stat(local);
    if (size <= this.settings.partBytes) return this.write(remote, await fs.readFile(local, { signal }), { signal });
    const handle = await fs.open(local, "r");
    try {
      return await this.multipart(remote, size, async (start, end) => {
        const chunk = Buffer.alloc(end - start);
        await handle.read(chunk, 0, chunk.length, start);
        return chunk;
      }, { signal });
    } finally {
      await handle.close();
    }
  }

  /** Upload a folder's files under remote. Returns how many were uploaded. */
  async putDirectory(local: string, remote = "", options: RequestOptions = {}): Promise<number> {
    const signal = signalFor(options);
    const prefix = remote === "" || remote.endsWith("/") ? remote : `${remote}/`;
    const files = (await walk(local)).sort();
    await inPool(files, 4, (file) => this.putFile(file, prefix + nodePath.relative(local, file).split(nodePath.sep).join("/"), { signal }));
    return files.length;
  }

  /** @internal Download one file to a path, through a temporary file. */
  async downloadTo(remote: string, target: string, options: RequestOptions = {}): Promise<void> {
    const signal = signalFor(options);
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    const temp = nodePath.join(nodePath.dirname(target), `.surfra-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      const body = await this.stream(remote, { signal });
      await fs.writeFile(temp, Readable.fromWeb(body as any), { signal });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  private root(): string {
    return nodePath.join(this.settings.cache, `vol-${this.name}`);
  }

  private statePath(): string {
    return nodePath.join(this.settings.cache, ".state", `vol-${this.name}.json`);
  }

  private async loadState(): Promise<State> {
    try {
      return parseState(await fs.readFile(this.statePath(), "utf8"));
    } catch {
      return new Map();
    }
  }

  private async saveState(state: State): Promise<void> {
    const path = this.statePath();
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(`${path}.tmp`, stringifyState(state));
    await fs.rename(`${path}.tmp`, path);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lock.then(work, work);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async head(path: string, signal?: AbortSignal): Promise<Entry[]> {
    const response = await this.send("HEAD", `files/${path.split("/").map(encodeURIComponent).join("/")}`, { signal });
    if (response.status === 404) return [];
    if (!response.ok) throw new SurfraError(response.status, response.statusText);
    return [{ path, size: Number(response.headers.get("content-length") ?? 0), etag: response.headers.get("etag") ?? "", modified: response.headers.get("last-modified") ?? "" }];
  }

  /** @internal */
  sync(path: string, mode: Mode, refresh: boolean, options: RequestOptions = {}): Promise<string> {
    const signal = signalFor(options);
    return this.serial(async () => {
      signal?.throwIfAborted();
      const root = this.root();
      const target = nodePath.join(root, path).replace(/[\\/]+$/, "");
      const previous = this.synced.get(path);
      if (previous && !refresh) {
        this.synced.set(path, previous === mode ? previous : "rw");
        return target;
      }
      const folder = isFolder(path);
      if (mode === "w") {
        // Write-only: nothing to download, only a place to write.
        await fs.mkdir(folder ? target : nodePath.dirname(target), { recursive: true });
        this.synced.set(path, mode);
        return target;
      }
      const state = await this.loadState();
      const remote = new Map((folder ? await this.ls(path, { recursive: true, signal }) : await this.head(path, signal)).map((entry) => [entry.path, entry]));
      const changed: Entry[] = [];
      for (const entry of remote.values()) {
        const known = state.get(entry.path);
        const local = await mtimeNs(nodePath.join(root, entry.path));
        if (!known || known.etag !== entry.etag || !local || local.size !== entry.size || local.mtime_ns !== known.mtime_ns) changed.push(entry);
      }
      await inPool(changed, DOWNLOADS, (entry) => this.downloadTo(entry.path, nodePath.join(root, entry.path), { signal }));
      for (const entry of changed) {
        const local = await mtimeNs(nodePath.join(root, entry.path));
        state.set(entry.path, { etag: entry.etag, size: entry.size, mtime_ns: local?.mtime_ns ?? 0n });
      }
      for (const key of [...state.keys()]) {
        const inside = folder ? key.startsWith(path) : key === path;
        if (inside && !remote.has(key)) {
          await fs.rm(nodePath.join(root, key), { force: true });
          state.delete(key);
        }
      }
      await this.saveState(state);
      if (folder) await fs.mkdir(target, { recursive: true });
      this.synced.set(path, mode);
      return target;
    });
  }

  /** Upload what changed in every folder synced with mode "w" or "rw". */
  commit(options: RequestOptions = {}): Promise<{ uploaded: number; deleted: number }> {
    const signal = signalFor(options);
    return this.serial(async () => {
      signal?.throwIfAborted();
      const state = await this.loadState();
      const root = this.root();
      let uploaded = 0;
      let deleted = 0;
      for (const [path, mode] of this.synced) {
        if (mode === "r") continue;
        const folder = isFolder(path);
        const base = nodePath.join(root, path);
        const found = folder ? await walk(base) : (await mtimeNs(base)) ? [base] : [];
        const seen = new Set<string>();
        for (const file of found) {
          if (nodePath.basename(file).startsWith(".surfra-")) continue;
          const remote = nodePath.relative(root, file).split(nodePath.sep).join("/");
          seen.add(remote);
          const local = (await mtimeNs(file))!;
          const known = state.get(remote);
          if (known && known.size === local.size && known.mtime_ns === local.mtime_ns) continue;
          const entry = await this.putFile(file, remote, { signal });
          state.set(remote, { etag: entry.etag, size: entry.size, mtime_ns: local.mtime_ns });
          uploaded++;
        }
        if (mode === "rw") {
          for (const key of [...state.keys()]) {
            const inside = folder ? key.startsWith(path) : key === path;
            if (!inside || seen.has(key)) continue;
            await this.rm(key, { signal }).catch((error) => {
              if (!(error instanceof SurfraError && error.status === 404)) throw error;
            });
            state.delete(key);
            deleted++;
          }
        }
      }
      await this.saveState(state);
      return { uploaded, deleted };
    });
  }

  /** Every volume in the organization. */
  static async list(settings: Partial<NodeSettings> = {}, options: RequestOptions = {}): Promise<any[]> {
    return BaseVolume.list(nodeSettingsFromEnv(settings), options);
  }
}

