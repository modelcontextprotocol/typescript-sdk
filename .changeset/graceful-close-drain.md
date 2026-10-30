---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core-internal': patch
---

Add opt-in graceful close: `client.close({ drainPendingRequests: true })` (or a per-call `{ timeoutMs }`) waits for in-flight requests to settle before the transport closes, so a completed HTTP response is no longer aborted mid-read by teardown — which OpenTelemetry's undici instrumentation previously reported as `UND_ERR_ABORTED` on 200 OK responses. A `ClientOptions.gracefulClose` default covers SIGINT-style shutdowns where the caller does not know what is in flight; requests still outstanding after the drain timeout are abandoned to the normal close path, and the default `close()` behavior is unchanged.
