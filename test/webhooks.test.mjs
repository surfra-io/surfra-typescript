// verifyWebhook against signatures made here with node:crypto (the shared vectors are in conformance h01).

import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyWebhook, WebhookVerificationError } from "../dist/node.js";
import * as browser from "../dist/index.js";

const BODY = JSON.stringify({ type: "task.updated", seq: 7, task: { id: "tx_1", status: "running", progress: 0.5, metadata: {}, stages: [], output: null } });
const NOW = 1761415391;
const sign = (secret, t = NOW, body = BODY) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

test("verifyWebhook reads the header from a Headers object, case-insensitively", async () => {
  const headers = new Headers({ "x-surfra-signature": `t=${NOW},v1=${sign("whsec_a")}` });
  assert.equal((await verifyWebhook(BODY, headers, "whsec_a", { now: NOW })).seq, 7);
  const upper = { "X-SURFRA-SIGNATURE": `t=${NOW},v1=${sign("whsec_a")}` };
  assert.equal((await verifyWebhook(Buffer.from(BODY), upper, "whsec_a", { now: NOW })).task.id, "tx_1");
});

test("verifyWebhook accepts any of several secrets and several v1 parts", async () => {
  const header = `t=${NOW},v1=${sign("whsec_new")}`;
  assert.equal((await verifyWebhook(BODY, header, ["whsec_old", "whsec_new"], { now: NOW })).seq, 7);
  const both = `t=${NOW},v1=${sign("whsec_x")},v1=${sign("whsec_old")}`;
  assert.equal((await verifyWebhook(new TextEncoder().encode(BODY).buffer, both, ["whsec_old"], { now: NOW })).seq, 7);
  await assert.rejects(verifyWebhook(BODY, header, ["whsec_old", "whsec_other"], { now: NOW }), WebhookVerificationError);
});

test("verifyWebhook rejects missing headers, stale timestamps and bad input", async () => {
  const header = `t=${NOW},v1=${sign("whsec_a")}`;
  await assert.rejects(verifyWebhook(BODY, {}, "whsec_a", { now: NOW }), WebhookVerificationError);
  await assert.rejects(verifyWebhook(BODY, new Headers(), "whsec_a", { now: NOW }), WebhookVerificationError);
  await assert.rejects(verifyWebhook(BODY, header, "whsec_a", { now: NOW + 61, toleranceSeconds: 60 }), WebhookVerificationError);
  assert.equal((await verifyWebhook(BODY, header, "whsec_a", { now: NOW + 60, toleranceSeconds: 60 })).seq, 7);
  await assert.rejects(verifyWebhook(BODY, `t=abc,v1=${sign("whsec_a")}`, "whsec_a", { now: NOW }), WebhookVerificationError);
  await assert.rejects(verifyWebhook(BODY, `garbage`, "whsec_a", { now: NOW }), WebhookVerificationError);
  await assert.rejects(verifyWebhook(BODY, header, [], { now: NOW }), WebhookVerificationError);
  await assert.rejects(verifyWebhook("not json", `t=${NOW},v1=${sign("whsec_a", NOW, "not json")}`, "whsec_a", { now: NOW }), WebhookVerificationError);
});

test("verifyWebhook uses the clock when now is not given", async () => {
  const t = Math.floor(Date.now() / 1000);
  assert.equal((await verifyWebhook(BODY, `t=${t},v1=${sign("whsec_a", t)}`, "whsec_a")).seq, 7);
});

test("the browser entry point exports verifyWebhook too", () => {
  assert.equal(typeof browser.verifyWebhook, "function");
  assert.equal(browser.WebhookVerificationError, WebhookVerificationError);
});
