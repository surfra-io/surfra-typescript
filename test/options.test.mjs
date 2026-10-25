// Cancellation, timeouts, callbackUrl and the credential cache, against a small local server.
// TypeScript has one mode (promises), so these sit beside the shared conformance cases.

import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { App, Client, Call, Job, SurfraFailure, Volume, Workflow } from "../dist/node.js";
import { anySignal, combineSignals, sleep } from "../dist/core.js";

/** A server whose handler is given; requests are recorded with their JSON bodies. */
async function serve(t, handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const item = { method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
      seen.push(item);
      handler(item, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const settings = { master: url, volumesUrl: url, envApiKey: "sfk_test", replicaToken: undefined, tokenFile: undefined, loginFile: undefined };
  return { url, seen, settings };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const hang = () => {}; // never answers

const running = (item, res) => {
  if (item.method === "POST" && item.path === "/v1/transactions") return json(res, 200, { id: "tx_1", status: "queued", stages: [] });
  if (item.path.startsWith("/v1/transactions/")) return json(res, 200, { id: "tx_1", status: "running", stages: [] });
  if (item.path.startsWith("/v1/workflows/")) return json(res, 200, { name: "flow", stages: [{ name: "a", app: "embed", depends: [] }] });
  json(res, 404, { error: "no route" });
};

async function elapsed(work) {
  const started = Date.now();
  const error = await work().then(() => undefined, (caught) => caught);
  return { error, ms: Date.now() - started };
}

test("abort via signal mid-poll rejects with AbortError at once", async (t) => {
  const fake = await serve(t, running);
  const call = await new Client(fake.settings).enqueue("embed", {});
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400); // the poll is asleep by then (100 ms, then 200 ms, ...)
  const { error, ms } = await elapsed(() => call.result({ signal: controller.signal }));
  assert.equal(error?.name, "AbortError");
  assert.ok(ms < 1500, `took ${ms} ms`);
  assert.ok(fake.seen.filter((item) => item.method === "GET").length >= 2, "polled before the abort");
});

test("an already-aborted signal makes no request", async (t) => {
  const fake = await serve(t, running);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new App("embed", fake.settings).info({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(fake.seen.length, 0);
});

test("abort while a submit waits out a 429", async (t) => {
  const fake = await serve(t, (_item, res) => json(res, 429, { error: "slow down" }, { "Retry-After": "30" }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const { error, ms } = await elapsed(() => new Client(fake.settings).enqueue("embed", {}, { signal: controller.signal }));
  assert.equal(error?.name, "AbortError");
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("timeoutMs aborts a hung fetch with TimeoutError", async (t) => {
  const fake = await serve(t, hang);
  const { error, ms } = await elapsed(() => new App("embed", fake.settings).info({ timeoutMs: 200 }));
  assert.equal(error?.name, "TimeoutError");
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("the per-request limit stops a hung control-plane call", async (t) => {
  const fake = await serve(t, hang);
  await assert.rejects(new Client({ ...fake.settings, requestTimeoutMs: 200 }).job("job_1"), { name: "TimeoutError" });
  await assert.rejects(new Volume("weights", { ...fake.settings, requestTimeoutMs: 200 }).info(), { name: "TimeoutError" });
});

test("timeoutMs on run bounds a hung poll and keeps SurfraFailure", async (t) => {
  const fake = await serve(t, (item, res) => (item.method === "POST" ? running(item, res) : hang()));
  const { error, ms } = await elapsed(() => new Client(fake.settings).run("embed", {}, { timeoutMs: 300 }));
  assert.ok(error instanceof SurfraFailure, String(error));
  assert.match(error.message, /still queued/);
  assert.equal(error.cause?.name, "TimeoutError");
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("timeoutMs on result ends mid-sleep, not after it", async (t) => {
  const fake = await serve(t, running);
  const client = new Client(fake.settings);
  const call = new Call(client, { id: "tx_1", status: "queued" });
  const { error, ms } = await elapsed(() => call.result({ timeoutMs: 250 }));
  assert.ok(error instanceof SurfraFailure);
  assert.match(error.message, /still running/);
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test("timeoutMs on Job.wait cuts the interval short", async (t) => {
  const fake = await serve(t, (_item, res) => json(res, 200, { id: "job_1", status: "running" }));
  const job = new Job(new Client(fake.settings), { id: "job_1", status: "queued" });
  const { error, ms } = await elapsed(() => job.wait({ intervalMs: 10_000, timeoutMs: 200 }));
  assert.ok(error instanceof SurfraFailure);
  assert.match(error.message, /job job_1 is still running/);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("timeoutMs bounds a hung volume read", async (t) => {
  const fake = await serve(t, hang);
  await assert.rejects(new Volume("weights", fake.settings).read("a.txt", { timeoutMs: 200 }), { name: "TimeoutError" });
});

test("callbackUrl is sent as callback_url, and only when set", async (t) => {
  const fake = await serve(t, running);
  const client = new Client(fake.settings);
  await client.enqueue("embed", { n: 1 }, { callbackUrl: "https://example.com/hook" });
  await client.submit([{ name: "a", app_name: "embed", depends_on: [], input: {} }], {}, { callbackUrl: "https://example.com/two" });
  await new App("embed", fake.settings).enqueue({}, { callbackUrl: "https://example.com/app" });
  await new Workflow("flow", fake.settings).enqueue({}, { callbackUrl: "https://example.com/flow" });
  await client.enqueue("embed", {});
  const posts = fake.seen.filter((item) => item.method === "POST" && item.path === "/v1/transactions").map((item) => item.body);
  assert.deepEqual(posts.map((body) => body.callback_url), ["https://example.com/hook", "https://example.com/two", "https://example.com/app", "https://example.com/flow", undefined]);
  assert.ok(!("callback_url" in posts[4]));
  assert.deepEqual(posts[3].metadata, { workflow: "flow" });
});

test("the token file is cached, and re-read once it changes", async (t) => {
  const fake = await serve(t, (_item, res) => json(res, 200, { files: [], folders: [], cursor: null }));
  const dir = await fs.mkdtemp(path.join(tmpdir(), "surfra-ts-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const token = path.join(dir, "token");
  await fs.writeFile(token, "first\n");

  const cached = new Volume("weights", { ...fake.settings, tokenFile: token, credentialCacheMs: 60_000 });
  await cached.ls();
  await fs.rm(token); // within the cache window, no read happens, so a missing file goes unnoticed
  await cached.ls();
  assert.deepEqual(fake.seen.map((item) => item.auth), ["Bearer first", "Bearer first"]);

  await fs.writeFile(token, "first\n");
  const fresh = new Volume("weights", { ...fake.settings, tokenFile: token, credentialCacheMs: 20 });
  await fresh.ls();
  await sleep(40);
  await fresh.ls(); // past the window, the stat matches: the cached value is used
  await fs.writeFile(token, "second-token\n");
  await sleep(40);
  await fresh.ls(); // the file changed: read again
  assert.deepEqual(fake.seen.slice(2).map((item) => item.auth), ["Bearer first", "Bearer first", "Bearer second-token"]);
});

test("the fallback combiner aborts with the first reason and unhooks", async () => {
  const a = new AbortController();
  const b = new AbortController();
  const both = combineSignals([a.signal, b.signal]);
  assert.equal(both.aborted, false);
  b.abort(new Error("from b"));
  assert.equal(both.aborted, true);
  assert.equal(both.reason.message, "from b");
  a.abort(new Error("from a"));
  assert.equal(both.reason.message, "from b");

  const early = new AbortController();
  early.abort();
  assert.equal(combineSignals([new AbortController().signal, early.signal]).aborted, true);
  assert.equal(anySignal([undefined, a.signal]), a.signal);
  assert.equal(anySignal([undefined]), undefined);
});

test("sleep rejects with the signal's reason", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const { error, ms } = await elapsed(() => sleep(10_000, controller.signal));
  assert.equal(error?.name, "AbortError");
  assert.ok(ms < 1000);
});
