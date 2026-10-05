---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Cancelling a request through `RequestOptions.signal` now rejects with
`SdkErrorCode.RequestAborted` instead of `SdkErrorCode.RequestTimeout`, so a
deliberate cancellation is distinguishable from a timeout expiry. Callers that
gated retry/backoff on `RequestTimeout` were also firing it on every user
cancellation.

`RequestAborted` is a new `SdkErrorCode` member. Only an elapsed
`RequestOptions.timeout` still carries `RequestTimeout` — the timeout handler
constructs a typed `SdkError(RequestTimeout, 'Request timed out')` that passes
through the abort wrap untouched. An abort `reason` that is already an
`SdkError` continues to be rethrown verbatim with its own code.

All four wrap sites move together, so the code does not depend on where the
abort lands: `Protocol.request()` (in-flight abort and pre-aborted signal),
the client's warm-cache pre-abort guard, and `Client.listen()`'s pre-abort
guard. A cache hit and a wire request now report the same code for the same
abort.
