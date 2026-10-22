// The shared SDK cases (surfra-sdk-tests/CASES.md), each against its own copy of the fake server.
// Set SURFRA_SDK_TESTS to the suite's folder; a sibling checkout is found on its own. Skipped when absent.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client, SurfraError, SurfraFailure, Volume } from "../dist/node.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = process.env.SURFRA_SDK_TESTS ?? path.join(HERE, "..", "..", "surfra-sdk-tests");
const PART = 1024;
const skip = !existsSync(path.join(SUITE, "server.py")) && "surfra-sdk-tests is not checked out";

async function start(t) {
  const child = spawn(process.env.SURFRA_SDK_PYTHON ?? "python3", [path.join(SUITE, "server.py"), "--port", "0"], {
    env: { ...process.env, SURFRA_VOLUMES_PART_BYTES: String(PART) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = await new Promise((resolve) => createInterface({ input: child.stdout }).once("line", resolve));
  const url = line.replace("listening on ", "").trim();
  const cache = await fs.mkdtemp(path.join(tmpdir(), "surfra-ts-test-"));
  t.after(async () => {
    child.kill();
    await fs.rm(cache, { recursive: true, force: true });
  });
  const settings = { master: url, volumesUrl: url, partBytes: PART, cache, envApiKey: "sfk_test", replicaToken: undefined, tokenFile: undefined, loginFile: undefined };
  const fake = {
    url,
    cache,
    settings,
    async volume(name) {
      await fetch(`${url}/v1/volumes`, { method: "POST", headers: { Authorization: "Bearer sfk_test", "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      return new Volume(name, settings);
    },
    seed: (volume, file, body) => fetch(`${url}/_test/files`, { method: "POST", body: JSON.stringify({ volume, path: file, body }) }),
    state: async () => (await fetch(`${url}/_test/state`)).json(),
    requests: async () => (await fake.state()).log.filter((item) => !item.path.startsWith("/_test/")),
  };
  return fake;
}

const temp = (name) => fs.mkdtemp(path.join(tmpdir(), `surfra-ts-${name}-`));

test("v01_small_upload_round_trips", { skip }, async (t) => {
  const fake = await start(t);
  const weights = await fake.volume("weights");
  await weights.write("a.txt", "hello");
  assert.equal(await weights.readText("a.txt"), "hello");
  assert.ok(!(await fake.requests()).some((item) => item.path.endsWith("/uploads")));
});

test("v02_large_upload_goes_in_parts", { skip }, async (t) => {
  const fake = await start(t);
  const dir = await temp("v02");
  const data = Buffer.from(Array.from({ length: PART * 3 + 17 }, (_, n) => (n * 7) % 251));
  await fs.writeFile(path.join(dir, "big.bin"), data);
  const weights = await fake.volume("weights");
  await weights.putFile(path.join(dir, "big.bin"), "big.bin");
  assert.deepEqual(Buffer.from(await weights.read("big.bin")), data);
  assert.ok((await fake.requests()).some((item) => item.path.endsWith("/uploads")));
});

test("v03_put_directory_keeps_relative_paths", { skip }, async (t) => {
  const fake = await start(t);
  const dir = await temp("v03");
  await fs.mkdir(path.join(dir, "sub"));
  await fs.writeFile(path.join(dir, "a"), "a");
  await fs.writeFile(path.join(dir, "sub", "b"), "b");
  assert.equal(await (await fake.volume("weights")).putDirectory(dir, "minilm/"), 2);
  assert.deepEqual(Object.keys((await fake.state()).files.weights).sort(), ["minilm/a", "minilm/sub/b"]);
});

test("v04_ls_lists_one_level_or_everything", { skip }, async (t) => {
  const fake = await start(t);
  const weights = await fake.volume("weights");
  for (const file of ["m/a", "m/sub/b", "top"]) await fake.seed("weights", file, "x");
  assert.deepEqual((await weights.ls("m/")).map((entry) => entry.path), ["m/a", "m/sub/"]);
  assert.deepEqual((await weights.ls("", { recursive: true })).map((entry) => entry.path).sort(), ["m/a", "m/sub/b", "top"]);
});

test("v05_local_downloads_once", { skip }, async (t) => {
  const fake = await start(t);
  const weights = await fake.volume("weights");
  await fake.seed("weights", "m/a", "aaa");
  await fake.seed("weights", "m/b", "bbb");
  const dir = await weights.path("m/").local();
  assert.equal(await fs.readFile(path.join(dir, "a"), "utf8"), "aaa");
  assert.equal(await fs.readFile(path.join(dir, "b"), "utf8"), "bbb");
  const before = (await fake.requests()).length;
  await weights.path("m/").local();
  assert.equal((await fake.requests()).length, before);
});

test("v06_a_new_object_fetches_only_changes", { skip }, async (t) => {
  const fake = await start(t);
  await fake.volume("weights");
  await fake.seed("weights", "m/a", "aaa");
  await fake.seed("weights", "m/b", "bbb");
  await new Volume("weights", fake.settings).path("m/").local();
  await fake.seed("weights", "m/a", "AAAA");
  await fetch(`${fake.url}/v1/weights/delete`, { method: "POST", headers: { Authorization: "Bearer sfk_test", "Content-Type": "application/json" }, body: JSON.stringify({ paths: ["m/b"] }) });
  const downloads = (await fake.state()).downloads;
  const dir = await new Volume("weights", fake.settings).path("m/").local();
  assert.equal((await fake.state()).downloads, downloads + 1);
  assert.equal(await fs.readFile(path.join(dir, "a"), "utf8"), "AAAA");
  assert.ok(!existsSync(path.join(dir, "b")));
});

test("v07_commit_uploads_changes_and_deletes", { skip }, async (t) => {
  const fake = await start(t);
  const ckpts = await fake.volume("ckpts");
  for (const file of ["r/a", "r/b", "r/c"]) await fake.seed("ckpts", file, file);
  const dir = await ckpts.path("r/").local({ mode: "rw" });
  await fs.writeFile(path.join(dir, "a"), "changed!");
  await fs.writeFile(path.join(dir, "d"), "new");
  await fs.rm(path.join(dir, "c"));
  assert.deepEqual(await ckpts.commit(), { uploaded: 2, deleted: 1 });
  const files = (await fake.state()).files.ckpts;
  assert.deepEqual(Object.keys(files).sort(), ["r/a", "r/b", "r/d"]);
  assert.equal(files["r/a"].body, "changed!");
  assert.deepEqual(await ckpts.commit(), { uploaded: 0, deleted: 0 });
});

test("v08_open_write_uploads_on_close_only", { skip }, async (t) => {
  const fake = await start(t);
  const results = await fake.volume("results");
  await results.write("runs/1.jsonl", "one\n");
  // A write that fails before it is sent uploads nothing.
  await assert.rejects(async () => {
    const body = (() => {
      throw new Error("boom");
    })();
    await results.write("runs/2.jsonl", body);
  });
  assert.deepEqual(Object.keys((await fake.state()).files.results), ["runs/1.jsonl"]);
});

test("v09_rm_file_and_folder", { skip }, async (t) => {
  const fake = await start(t);
  const weights = await fake.volume("weights");
  for (const file of ["a", "old/x", "old/y"]) await fake.seed("weights", file, "x");
  await weights.rm("a");
  assert.equal(await weights.rm("old/", { recursive: true }), 2);
  assert.deepEqual((await fake.state()).files.weights, {});
});

test("v10_missing_file_raises_404", { skip }, async (t) => {
  const fake = await start(t);
  await assert.rejects((await fake.volume("weights")).read("nope"), (error) => error instanceof SurfraError && error.status === 404 && error.detail.includes("no such file"));
});

test("v11_token_file_wins_over_the_api_key", { skip }, async (t) => {
  const fake = await start(t);
  await fake.volume("weights");
  const dir = await temp("v11");
  await fs.writeFile(path.join(dir, "token"), "aaa.bbb.ccc\n");
  await new Volume("weights", { ...fake.settings, tokenFile: path.join(dir, "token") }).ls();
  assert.equal((await fake.requests()).at(-1).auth, "Bearer aaa.bbb.ccc");
});

test("v12_no_credential_says_what_to_set", { skip }, async (t) => {
  const fake = await start(t);
  await assert.rejects(new Volume("weights", { ...fake.settings, envApiKey: undefined }).ls(), (error) => error instanceof SurfraFailure && error.message.includes("SURFRA_API_KEY"));
});

test("v13_writing_to_a_new_volume_creates_it", { skip }, async (t) => {
  const fake = await start(t);
  await new Volume("fresh", fake.settings).write("a.txt", "x");
  assert.equal((await fake.state()).files.fresh["a.txt"].body, "x");
});

test("v14_another_sdks_state_file_is_honored", { skip }, async (t) => {
  const fake = await start(t);
  await fake.volume("weights");
  await fake.seed("weights", "m/a", "aaa");
  const local = path.join(fake.cache, "vol-weights", "m", "a");
  await fs.mkdir(path.dirname(local), { recursive: true });
  await fs.writeFile(local, "aaa");
  const { mtimeNs } = await fs.stat(local, { bigint: true });
  const etag = (await fake.state()).files.weights["m/a"].etag;
  await fs.mkdir(path.join(fake.cache, ".state"), { recursive: true });
  await fs.writeFile(path.join(fake.cache, ".state", "vol-weights.json"), `{"m/a": {"etag": ${JSON.stringify(etag)}, "size": 3, "mtime_ns": ${mtimeNs}}}`);
  await new Volume("weights", fake.settings).path("m/").local();
  assert.equal((await fake.state()).downloads, 0);
});

test("a01_run_returns_the_output", { skip }, async (t) => {
  const fake = await start(t);
  assert.deepEqual(await new Client(fake.settings).run("embed", { texts: ["hi"] }, { timeoutMs: 30000 }), { app: "embed", echo: { texts: ["hi"] } });
});

test("a02_enqueue_then_result", { skip }, async (t) => {
  const fake = await start(t);
  const client = new Client(fake.settings);
  assert.deepEqual(await (await client.enqueue("embed", { n: 1 })).result({ timeoutMs: 30000 }), { app: "embed", echo: { n: 1 } });
  await assert.rejects((await client.enqueue("fails", {})).result({ timeoutMs: 30000 }), /ValueError/);
});

test("j01_job_with_volumes_finishes", { skip }, async (t) => {
  const fake = await start(t);
  const job = await new Client(fake.settings).submitJob({ entrypoint: "python train.py", image: "img", providers: [{ provider: "local" }], volumes: [new Volume("weights").grant("r")] });
  assert.deepEqual((await fake.state()).jobs[job.id].volumes, ["weights:r"]);
  const view = await job.wait({ intervalMs: 50, timeoutMs: 30000 });
  assert.equal(view.status, "succeeded");
  assert.equal(view.exit_code, 0);
});
