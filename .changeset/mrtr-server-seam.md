---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

Add the server side of multi round-trip requests (protocol revision 2026-07-28, SEP-2322). Handlers for `tools/call`, `prompts/get`, and `resources/read` can return the value built by `inputRequired()` (exported from the server package together with `acceptedContent()`)
to request additional client input in-band; the structured-content requirement and the tools/call result-schema validation are skipped for that return, the encode seam emits it as `resultType: 'input_required'`, and the handler reads the responses on re-entry from
`ctx.mcpReq.inputResponses` (with non-bare entries reported via `ctx.mcpReq.droppedInputResponseKeys`). The seam re-checks the at-least-one rule for hand-built results, checks every embedded request against the capabilities the client declared on that request's envelope
(answering the typed `-32021` error on violation), and fails loudly — never emitting a mis-typed result — when an input-required value is returned from any other method or toward a 2025-era request. A `UrlElicitationRequiredError` escaping a handler on a 2026-era request
fails as an internal error with a clear steer to `inputRequired.elicitUrl(...)`, so the `-32042` error never reaches the 2026-07-28 wire; 2025-era serving keeps today's `-32042` behavior
exactly. The typed local error raised when push-style server-to-client request APIs are used while serving a 2026-era request now steers to `inputRequired(...)`. Tool, prompt, and resource callback types accept the new return alongside their existing result types; 2025-era
wire behavior is unchanged. An optional `ServerOptions.requestState.verify` hook lets a server integrity-check the echoed `requestState` before the handler runs — a throw answers the wire-level `-32602` Invalid Params error with `data.reason: 'invalid_request_state'`; the SDK provides no default verification.
