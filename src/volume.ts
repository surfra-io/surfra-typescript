// Volumes over HTTP, for every runtime. The Node build adds local sync on top (see node.ts).

import { checked, controlCredential, credential, encodePath, settingsFromEnv, SurfraError, type Settings } from "./core.js";

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

  protected async send(method: string, route: string, init: { body?: BodyInit; json?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(this.url(route));
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${credential(this.settings)}`, ...init.headers };
    let body = init.body;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    return fetch(url, { method, headers, body });
  }

  /** A request to the volumes service. Writes to a volume that does not exist yet create it first. */
  protected async request(method: string, route: string, init: Parameters<Volume["send"]>[2] = {}, create = false): Promise<Response> {
    const response = await this.send(method, route, init);
    if (create && response.status === 404) {
      const text = await response.text();
      if (text.includes("no volume")) {
        await this.create();
        return checked(await this.send(method, route, init));
      }
      throw new SurfraError(404, (() => { try { return JSON.parse(text).error ?? text; } catch { return text; } })());
    }
    return checked(response);
  }

  protected async control(method: string, route: string, json?: unknown): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${controlCredential(this.settings)}` };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.settings.master}${route}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return (await checked(response)).json();
  }

  /** Create the volume. Writing to a volume that does not exist yet does this for you. */
  create(): Promise<any> {
    return this.control("POST", "/v1/volumes", { name: this.name });
  }

  /** Size, file count and what uses the volume. */
  info(): Promise<any> {
    return this.control("GET", `/v1/volumes/${encodeURIComponent(this.name)}`);
  }

  /** Delete the whole volume and every file in it. Needs an admin. */
  delete(): Promise<any> {
    return this.control("DELETE", `/v1/volumes/${encodeURIComponent(this.name)}`);
  }

  /** Every volume in the organization. */
  static async list(settings: Partial<Settings> = {}): Promise<any[]> {
    return (await new Volume("_", settings).control("GET", "/v1/volumes")).volumes;
  }

  /** Files under prefix. Without recursive, folders show as entries ending in "/". */
  async ls(prefix = "", { recursive = false } = {}): Promise<Entry[]> {
    const out: Entry[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string> = { prefix, recursive: recursive ? "1" : "0" };
      if (cursor) query.cursor = cursor;
      const page = (await (await this.request("GET", "list", { query })).json()) as Listing;
      out.push(...page.files);
      if (!recursive) out.push(...(page.folders ?? []).map((path) => ({ path, size: 0, etag: "", modified: "" })));
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  /** Delete a file, or with recursive everything under a folder. Returns how many were deleted. */
  async rm(path: string, { recursive = false } = {}): Promise<number> {
    if (!recursive) {
      await this.request("DELETE", `files/${encodePath(path)}`);
      return 1;
    }
    const prefix = path.endsWith("/") ? path : `${path}/`;
    let total = 0;
    for (;;) {
      const result = (await (await this.request("POST", "delete", { json: { prefix } })).json()) as { deleted: number; more: boolean };
      total += result.deleted;
      if (!result.more) return total;
    }
  }

  /** One file's bytes. */
  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.request("GET", `files/${encodePath(path)}`)).arrayBuffer());
  }

  /** One file as text. */
  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  /** A file's response, for streaming large downloads. */
  async stream(path: string): Promise<ReadableStream<Uint8Array>> {
    return (await this.request("GET", `files/${encodePath(path)}`)).body!;
  }

  /** Upload one file. More than the part size goes up in parts. */
  async write(path: string, data: Body, { ifMatch }: { ifMatch?: string } = {}): Promise<Entry> {
    const blob = asBlob(data);
    if (blob.size > this.settings.partBytes) return this.multipart(path, blob.size, (start, end) => blob.slice(start, end).arrayBuffer());
    const headers: Record<string, string> = { "Content-Length": String(blob.size) };
    if (ifMatch) headers["If-Match"] = ifMatch;
    const stored = await (await this.request("PUT", `files/${encodePath(path)}`, { body: await blob.arrayBuffer(), headers }, true)).json();
    return { path: stored.path, size: stored.size, etag: stored.etag, modified: "" };
  }

  /** A multipart upload from a reader of byte ranges, so a file never has to fit in memory. */
  protected async multipart(path: string, size: number, slice: (start: number, end: number) => Promise<ArrayBuffer | Uint8Array>): Promise<Entry> {
    const started = await (await this.request("POST", "uploads", { json: { path, size } }, true)).json();
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
          const sent = await (await this.request("PUT", `uploads/${upload}/${number}`, { body: chunk as BodyInit, query: { path }, headers: { "Content-Length": String(chunk.byteLength) } })).json();
          parts.push({ part: number, etag: sent.etag });
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOADS, count) }, worker));
    } catch (error) {
      await this.request("DELETE", `uploads/${upload}`, { query: { path } }).catch(() => undefined);
      throw error;
    }
    parts.sort((a, b) => a.part - b.part);
    const stored = await (await this.request("POST", `uploads/${upload}/complete`, { json: { path, parts } })).json();
    return { path: stored.path, size: stored.size, etag: stored.etag, modified: "" };
  }
}
