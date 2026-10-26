// Verifying Surfra callbacks: the X-Surfra-Signature header over the raw request body.
//
//   X-Surfra-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>[,v1=...]
//
// There is one v1 per signing secret, so during a rotation both the old and the new secret verify.
// Uses Web Crypto, so it runs in Node >= 18, browsers, Workers, Deno and Bun.

const HEADER = "x-surfra-signature";

// Node 18 has no global `crypto` in ES modules; node.ts hands in node:crypto's webcrypto.
let fallbackSubtle: SubtleCrypto | undefined;

/** @internal Used by node.ts where globalThis.crypto is missing (Node 18). */
export function useSubtleCrypto(subtle: SubtleCrypto): void {
  fallbackSubtle = subtle;
}
const TOLERANCE_SECONDS = 300;

/** The callback could not be verified: bad or missing signature, stale timestamp, or a body that is not JSON. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** The body of a `task.updated` callback. */
export interface CallbackPayload {
  type: "task.updated";
  seq: number;
  task: {
    id: string;
    status: string;
    progress: number | null;
    metadata: Record<string, unknown>;
    created_at?: string;
    finished_at?: string | null;
    stages: { id: string; name: string; app: string; status: string; attempt: number; progress: number | null; error: string | null }[];
    output: unknown;
    output_truncated?: boolean;
  };
}

export interface VerifyWebhookOptions {
  /** How far the signature timestamp may be from now, either way. Default 300 seconds. */
  toleranceSeconds?: number;
  /** The current time in unix seconds. For tests; defaults to the clock. */
  now?: number;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function signatureHeader(source: HeaderBag | string): string | undefined {
  if (typeof source === "string") return source;
  if (typeof (source as Headers).get === "function") return (source as Headers).get(HEADER) ?? undefined;
  for (const [key, value] of Object.entries(source as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== HEADER || value === undefined) continue;
    return Array.isArray(value) ? value.join(",") : value;
  }
  return undefined;
}

function bytesOf(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new WebhookVerificationError("the body must be a string, Uint8Array or ArrayBuffer");
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings without returning early on the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (i < b.length ? b.charCodeAt(i) : 0);
  return diff === 0;
}

function parse(header: string): { timestamp: number; signatures: string[] } {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const raw of header.split(",")) {
    const part = raw.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) throw new WebhookVerificationError("malformed X-Surfra-Signature header");
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (timestamp !== undefined || !/^\d+$/.test(value)) throw new WebhookVerificationError("malformed timestamp in X-Surfra-Signature header");
      timestamp = Number(value);
    } else if (key === "v1") {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === undefined) throw new WebhookVerificationError("no timestamp in X-Surfra-Signature header");
  if (signatures.length === 0) throw new WebhookVerificationError("no v1 signature in X-Surfra-Signature header");
  return { timestamp, signatures };
}

/**
 * Checks a callback's X-Surfra-Signature against the raw body and returns the parsed body.
 * Pass the body exactly as received (not re-serialized JSON), the request headers or the header value,
 * and the signing secret, or several secrets while rotating. Throws WebhookVerificationError.
 */
export async function verifyWebhook(
  body: string | Uint8Array | ArrayBuffer,
  headersOrSignature: HeaderBag | string,
  secret: string | string[],
  options: VerifyWebhookOptions = {},
): Promise<CallbackPayload> {
  const header = signatureHeader(headersOrSignature);
  if (!header || !header.trim()) throw new WebhookVerificationError("missing X-Surfra-Signature header");
  const { timestamp, signatures } = parse(header);

  const tolerance = options.toleranceSeconds ?? TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) throw new WebhookVerificationError("X-Surfra-Signature timestamp is outside the tolerance");

  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((item) => item.length > 0);
  if (secrets.length === 0) throw new WebhookVerificationError("no signing secret given");

  const bytes = bytesOf(body);
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix);
  message.set(bytes, prefix.length);

  const subtle = globalThis.crypto?.subtle ?? fallbackSubtle;
  if (!subtle) throw new WebhookVerificationError("Web Crypto (globalThis.crypto.subtle) is not available");

  let matched = false;
  for (const item of secrets) {
    const key = await subtle.importKey("raw", new TextEncoder().encode(item), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = hex(await subtle.sign("HMAC", key, message));
    for (const candidate of signatures) if (constantTimeEqual(expected, candidate)) matched = true;
  }
  if (!matched) throw new WebhookVerificationError("X-Surfra-Signature does not match the body");

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as CallbackPayload;
  } catch {
    throw new WebhookVerificationError("the callback body is not JSON");
  }
}
