# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-25

### Added
- Cancellation and timeouts: every network method takes an optional `{ signal, timeoutMs }`, alongside
  its existing options. Cancelled calls reject with the signal's reason (`AbortError`, or `TimeoutError`
  for timeouts). `Call.result`, `run` and `Job.wait` still throw `SurfraFailure` when their `timeoutMs`
  runs out, now also mid-request and mid-sleep, with the `TimeoutError` as `cause`.
- A per-request limit for control-plane calls, 60 s by default (`requestTimeoutMs` setting; `0` turns
  it off), so a hung request can no longer hang a call forever. Volume transfers have no default limit.
- `callbackUrl` on `Client.submit`/`enqueue`/`run`, `App.enqueue`/`run` and `Workflow.enqueue`/`run`,
  sent as `callback_url`. Stored with the transaction; delivery is planned.
- `credentialCacheMs` Node setting (default 1000 ms).
- Exported types `RequestOptions`, `SubmitOptions` and `WaitOptions`.

### Changed
- Node: the token file and saved login are no longer read on every request. A read is reused, then
  checked with a stat at most once per `credentialCacheMs`, and read again only when the file changed.
- `Client.run` and `Workflow.run`: `timeoutMs` now bounds the submit as well as the wait.

## [0.1.0] - 2026-10-22

### Added
- First release: apps, workflows, jobs and volumes over `fetch`; Node local sync and commit.

