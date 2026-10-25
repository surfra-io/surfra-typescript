// Volumes over HTTP, for every runtime. The Node build adds local sync on top (see node.ts).

import { checked, controlCredential, credential, encodePath, guarded, REQUEST_TIMEOUT_MS, settingsFromEnv, signalFor, SurfraError, type RequestOptions, type Settings } from "./core.js";

export type Mode = "r" | "w" | "rw";

/** One file in a volume. Folders from a non-recursive listing end in "/" and have size 0. */
export interface Entry {
  path: string;
  size: number;
  etag: string;
  modified: string;
}

interface Listing {
  files: Entry[];
  folders?: string[];
  cursor: string | null;
}

const UPLOADS = 4;

export type Body = string | Uint8Array | ArrayBuffer | Blob;

function asBlob(data: Body): Blob {
  if (data instanceof Blob) return data;
  return new Blob([typeof data === "string" ? new TextEncoder().encode(data) : (data as BlobPart)]);
}

/** A volume by name. No request is made until it is used. */
export class Volume {
  readonly name: string;
  protected readonly settings: Settings;

  constructor(name: string, settings: Partial<Settings> = {}) {
    this.name = name;
    this.settings = { ...settingsFromEnv(), ...settings };
  }

  /** A grant such as "weights:r", for jobs and apps. */
  grant(mode: Mode): string {
    return `${this.name}:${mode}`;
  }

  protected url(route: string): string {
    return `${this.settings.volumesUrl}/v1/${encodeURIComponent(this.name)}/${route}`;
  }

  protected async send(method: string, route: string, init: { body?: BodyInit; json?: unknown; query?: Record<string, string>; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const url = new URL(this.url(route));
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${credential(this.settings)}`, ...init.headers };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    return fetch(url, { method, headers, body, signal: init.signal });
  }

  /** A request to the volumes service. Writes to a volume that does not exist yet create it first. */
  protected async request(method: string, route: string, init: Parameters<Volume["send"]>[2] = {}, create = false): Promise<Response> {
    const response = await this.send(method, route, init);
    if (create && response.status === 404) {
      const text = await response.text();
      if (text.includes("no volume")) {
        await this.create({ signal: init.signal });
        return checked(await this.send(method, route, init));
      }
      throw new SurfraError(404, (() => { try { return JSON.parse(text).error ?? text; } catch { return text; } })());
    }
    return checked(response);
  }

  protected async control(method: string, route: string, json?: unknown, options: RequestOptions = {}): Promise<any> {
    const signal = signalFor(options, this.settings.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    return guarded(signal, async () => {
      const headers: Record<string, string> = { Authorization: `Bearer ${controlCredential(this.settings)}` };
      if (json !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`${this.settings.master}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal });
      return (await checked(response)).json();
    });
  }

  /** Create the volume. Writing to a volume that does not exist yet does this for you. */
  create(options: RequestOptions = {}): Promise<any> {
    return this.control("POST", "/v1/volumes", { name: this.name }, options);
  }

  /** Size, file count and what uses the volume. */
  info(options: RequestOptions = {}): Promise<any> {
    return this.control("GET", `/v1/volumes/${encodeURIComponent(this.name)}`, undefined, options);
  }

  /** Delete the whole volume and every file in it. Needs an admin. */
  delete(options: RequestOptions = {}): Promise<any> {
    return this.control("DELETE", `/v1/volumes/${encodeURIComponent(this.name)}`, undefined, options);
  }

  /** Every volume in the organization. */
  static async list(settings: Partial<Settings> = {}, options: RequestOptions = {}): Promise<any[]> {
    return (await new Volume("_", settings).control("GET", "/v1/volumes", undefined, options)).volumes;
  }

  /** Files under prefix. Without recursive, folders show as entries ending in "/". `timeoutMs` bounds every page together. */
  async ls(prefix = "", { recursive = false, ...options }: { recursive?: boolean } & RequestOptions = {}): Promise<Entry[]> {
    const signal = signalFor(options);
    return guarded(signal, async () => {
      const out: Entry[] = [];
      let cursor: string | null = null;
      do {
        const query: Record<string, string> = { prefix, recursive: recursive ? "1" : "0" };
        if (cursor) query.cursor = cursor;
        const page = (await (await this.request("GET", "list", { query, signal })).json()) as Listing;
        out.push(...page.files);
        if (!recursive) out.push(...(page.folders ?? []).map((path) => ({ path, size: 0, etag: "", modified: "" })));
        cursor = page.cursor;
      } while (cursor);
      return out;
    });
  }

  /** Delete a file, or with recursive everything under a folder. Returns how many were deleted. */
  async rm(path: string, { recursive = false, ...options }: { recursive?: boolean } & RequestOptions = {}): Promise<number> {
    const signal = signalFor(options);
    return guarded(signal, async () => {
      if (!recursive) {
        await this.request("DELETE", `files/${encodePath(path)}`, { signal });
        return 1;
      }
      const prefix = path.endsWith("/") ? path : `${path}/`;
      let total = 0;
      for (;;) {
        const result = (await (await this.request("POST", "delete", { json: { prefix }, signal })).json()) as { deleted: number; more: boolean };
        total += result.deleted;
        if (!result.more) return total;
      }
    });
  }

  /** One file's bytes. */
  async read(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const signal = signalFor(options);
    return guarded(signal, async () => new Uint8Array(await (await this.request("GET", `files/${encodePath(path)}`, { signal })).arrayBuffer()));
  }

  /** One file as text. */
  async readText(path: string, options: RequestOptions = {}): Promise<string> {
    return new TextDecoder().decode(await this.read(path, options));
  }

  /** A file's response, for streaming large downloads. `signal` and `timeoutMs` also cover reading the stream. */
  async stream(path: string, options: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const signal = signalFor(options);
    return guarded(signal, async () => (await this.request("GET", `files/${encodePath(path)}`, { signal })).body!);
  }

  /** Upload one file. More than the part size goes up in parts. `timeoutMs` bounds the whole upload. */
  async write(path: string, data: Body, { ifMatch, ...options }: { ifMatch?: string } & RequestOptions = {}): Promise<Entry> {
    const blob = asBlob(data);
    const signal = signalFor(options);
    if (blob.size > this.settings.partBytes) return this.multipart(path, blob.size, (start, end) => blob.slice(start, end).arrayBuffer(), { signal });
    const headers: Record<string, string> = { "Content-Length": String(blob.size) };
    if (ifMatch) headers["If-Match"] = ifMatch;
    return guarded(signal, async () => {
      const stored = await (await this.request("PUT", `files/${encodePath(path)}`, { body: await blob.arrayBuffer(), headers, signal }, true)).json();
      return { path: stored.path, size: stored.size, etag: stored.etag, modified: "" };
    });
  }

  /** A multipart upload from a reader of byte ranges, so a file never has to fit in memory. */
  protected async multipart(path: string, size: number, slice: (start: number, end: number) => Promise<ArrayBuffer | Uint8Array>, options: RequestOptions = {}): Promise<Entry> {
    const signal = signalFor(options);
    return guarded(signal, () => this.multipartWith(path, size, slice, signal));
  }

  private async multipartWith(path: string, size: number, slice: (start: number, end: number) => Promise<ArrayBuffer | Uint8Array>, signal: AbortSignal | undefined): Promise<Entry> {
    const started = await (await this.request("POST", "uploads", { json: { path, size }, signal }, true)).json();
    const upload = encodeURIComponent(started.upload_id);
    const partSize: number = started.part_size || this.settings.partBytes;
    const count = Math.ceil(size / partSize);
    const parts: { part: number; etag: string }[] = [];
    try {
      let next = 1;
      const worker = async () => {
        while (next <= count) {
          const number = next++;
          const start = (number - 1) * partSize;
          const chunk = await slice(start, Math.min(start + partSize, size));
          signal?.throwIfAborted?.();
          const sent = await (await this.request("PUT", `uploads/${upload}/${number}`, { body: chunk as BodyInit, query: { path }, headers: { "Content-Length": String(chunk.byteLength) }, signal })).json();
          parts.push({ part: number, etag: sent.etag });
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOADS, count) }, worker));
    } catch (error) {
      // Not the caller's signal, which may be why we are here; the per-request limit still applies.
      await this.request("DELETE", `uploads/${upload}`, { query: { path }, signal: signalFor({}, this.settings.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) }).catch(() => undefined);
      throw error;
    }
    parts.sort((a, b) => a.part - b.part);
    const stored = await (await this.request("POST", `uploads/${upload}/complete`, { json: { path, parts }, signal })).json();
    return { path: stored.path, size: stored.size, etag: stored.etag, modified: "" };
  }
}
