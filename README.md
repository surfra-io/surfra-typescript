# surfra

The Surfra SDK for TypeScript and JavaScript: volumes, apps and jobs on serverless GPUs across your own clouds.

```bash
npm install surfra
```

No dependencies. Works in Node 18+, Bun, Deno, Cloudflare Workers and browsers. Node also gets local sync.

## Call an app

```ts
import { Client } from "surfra";

const client = new Client();
const output = await client.run("embed", { texts: ["hello"] }, { timeoutMs: 600_000 });

const call = await client.enqueue("sdxl", { prompt: "a lighthouse" });
const image = await call.result();
```

## Cancel and time out

Every network method takes an optional `{ signal, timeoutMs }` beside its own options. A cancelled call
rejects with the signal's reason: an `AbortError`, or a `TimeoutError` when the time runs out.

```ts
const controller = new AbortController();
const call = await client.enqueue("sdxl", { prompt: "a lighthouse" }, { signal: controller.signal });
button.onclick = () => controller.abort();          // stops waiting at once, even mid-request
const image = await call.result({ signal: controller.signal, timeoutMs: 600_000 });

const info = await new App("embed").info({ timeoutMs: 5_000 });   // TimeoutError after 5 s
```

On `result`, `run` and `job.wait`, `timeoutMs` bounds the whole wait, including a request in flight, and
throws `SurfraFailure` (with the `TimeoutError` as `cause`) as before. Each control-plane request also has
its own limit, 60 s by default: set `requestTimeoutMs` on `Client`, `App`, `Workflow` or `Volume`, or `0`
for none. Volume uploads and downloads have no default limit; pass `timeoutMs` or a `signal`.

`AbortSignal.any` is used where the runtime has it, and a small fallback where it does not.

## Callbacks

```ts
await client.enqueue("embed", { texts: ["hi"] }, { callbackUrl: "https://example.com/hooks/surfra" });
```

`callbackUrl` (on `submit`, `enqueue` and `run`, for apps and workflows): Surfra POSTs the task's latest
state there each time it changes, signed with `X-Surfra-Signature`.

### Verify callbacks

Each callback carries `X-Surfra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`. Verify it against the
raw body bytes, before any JSON parsing:

```ts
import express from "express";
import { verifyWebhook, WebhookVerificationError } from "surfra";

const app = express();
app.post("/hooks/surfra", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body, req.headers, process.env.SURFRA_WEBHOOK_SECRET!);
    console.log(event.seq, event.task.id, event.task.status);
    res.sendStatus(204);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.sendStatus(400);
    throw err;
  }
});
```

`headers` may be a `Headers` object (Fetch, Workers), a plain header object, or the header value. While
rotating the signing secret, pass both: `verifyWebhook(body, headers, [newSecret, oldSecret])`. Timestamps
more than 300 s from now are rejected; change that with `{ toleranceSeconds }`.

## Volumes

```ts
import { Volume } from "surfra";

const weights = new Volume("weights");

// Node: a folder of the volume, synced to local disk. Only changed files download.
const dir = await weights.path("minilm/").local();

// Anywhere: one file in, one file out.
await weights.write("notes/run-1.txt", "done");
const text = await weights.readText("notes/run-1.txt");

// Node: change a folder in place, then upload what changed.
const ckpts = new Volume("ckpts");
const runDir = await ckpts.path("run-7/").local({ mode: "rw" });
// ...write files into runDir...
await ckpts.commit();
```

## Jobs

```ts
const job = await client.submitJob({
  entrypoint: "python train.py --epochs 3",
  image: "ghcr.io/acme/train:3",
  providers: [{ provider: "runpod", gpu: "rtx4090" }],
  volumes: ["weights:r", "ckpts:rw"],
});
await job.wait();
```

## Credentials

Inside a Surfra app or job nothing needs setting: `SURFRA_VOLUMES_URL` is a local proxy that adds the
credential. Elsewhere, set `SURFRA_API_KEY`, or pass `{ apiKey }` to `Client` or `Volume`. In a browser,
pass a key you are comfortable exposing, or call your own backend instead.

The order is the same in every Surfra SDK: an explicit key, `SURFRA_VOLUMES_TOKEN_FILE`, `SURFRA_API_KEY`,
`SURFRA_REPLICA_TOKEN`, then the session `surfra login` saved.

In Node, the token file and the saved login are read once and reused; the file is checked again at most
once a second (`credentialCacheMs`), and read again only when it changed, so a rotated token is picked up.

## Tests

The tests are the shared [Surfra SDK cases](https://github.com/surfra-io/surfra-sdk-tests), run against its
fake server. Check it out next to this repository, or set `SURFRA_SDK_TESTS`, then `npm test`.
