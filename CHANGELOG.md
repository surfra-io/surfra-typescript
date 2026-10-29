# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-29

### Added
- Every request sends `Surfra-Client: surfra-typescript/<version>`, so the control plane can trace errors to a release.
- Overload retries for every control-plane and volume request:
  - **Retried for every request:** 429 `RATE_LIMITED`, 503 `QUEUE_FULL` and 503 `SERVER_BUSY`, after `Retry-After`, plus connections that never got through.
  - **Retried only for `GET`/`HEAD`:** 502/503/504 without a Surfra error body, and connections lost after sending.
  - **Never retried:** `APP_PAUSED`, `DEFCON_ACTIVE`, other 4xx, and submissions that got a 504 or lost their connection after sending.
  - **Limits:** `maxRetries` (7), `retryDeadlineMs` (180 000) and `onRetry`, per client (settings) and per call (options). `SURFRA_DEBUG=1` logs each retry.
- `SurfraError.type`, `attempts`, `outcomeUnknown` and `retryAfter`; `SurfraFailure` carries the same for connection failures.
- 402 `HTTP_CALLS_LIMIT` (the organization used its included HTTP calls this month and has no card on file) is named in the docs and never retried; conformance case r13.

### Changed
- The submit-only 429 retry (5 tries, 1 to 60 s) is replaced by the policy above.

## [0.2.1] - 2026-10-26

### Added
- `verifyWebhook(body, headers, secret, { toleranceSeconds })` checks a callback's `X-Surfra-Signature`
  (HMAC-SHA256 over `<t>.<raw body>`, constant-time, any of several secrets or `v1=` parts during
  rotation, 300 s timestamp tolerance) and returns the parsed `CallbackPayload`; failures throw
  `WebhookVerificationError`. Uses Web Crypto, on both entry points.

## [0.2.0] - 2026-10-25

### Added
- Cancellation and timeouts: every network method takes an optional `{ signal, timeoutMs }`, alongside
  its existing options. Cancelled calls reject with the signal's reason (`AbortError`, or `TimeoutError`
  for timeouts). `Call.result`, `run` and `Job.wait` still throw `SurfraFailure` when their `timeoutMs`
  runs out, now also mid-request and mid-sleep, with the `TimeoutError` as `cause`.
- A per-request limit for control-plane calls, 60 s by default (`requestTimeoutMs` setting; `0` turns
  it off), so a hung request can no longer hang a call forever. Volume transfers have no default limit.
- `callbackUrl` on `Client.submit`/`enqueue`/`run`, `App.enqueue`/`run` and `Workflow.enqueue`/`run`,
  sent as `callback_url`: Surfra POSTs the task's latest state there each time it changes.
- `credentialCacheMs` Node setting (default 1000 ms).
- Exported types `RequestOptions`, `SubmitOptions` and `WaitOptions`.

### Changed
- Node: the token file and saved login are no longer read on every request. A read is reused, then
  checked with a stat at most once per `credentialCacheMs`, and read again only when the file changed.
- `Client.run` and `Workflow.run`: `timeoutMs` now bounds the submit as well as the wait.

## [0.1.0] - 2026-10-22

### Added
- First release: apps, workflows, jobs and volumes over `fetch`; Node local sync and commit.

