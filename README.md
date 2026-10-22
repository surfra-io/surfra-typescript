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

## Tests

The tests are the shared [Surfra SDK cases](https://github.com/surfra-io/surfra-sdk-tests), run against its
fake server. Check it out next to this repository, or set `SURFRA_SDK_TESTS`, then `npm test`.
