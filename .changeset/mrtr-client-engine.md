---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
---

Add the client side of multi round-trip requests (protocol revision 2026-07-28, SEP-2322). The neutral `InputRequest`/`InputResponse`/`InputRequests`/`InputResponses`/`InputRequiredResult` types and the `isInputRequiredResult()` guard ship as the neutral surface (the
`inputRequired()` builder family and the `acceptedContent()` reader are exported by the server package as part of the server-side change); the 2026-07-28 wire codec models the in-band vocabulary (embedded requests and bare responses) and the retry-channel request fields. On the
client, an `input_required` answer to `tools/call`, `prompts/get`, or `resources/read` on a 2026-07-28 connection is now fulfilled automatically by default: the embedded requests are dispatched to the client's already-registered elicitation/sampling/roots handlers, and the
original call is retried with the collected `inputResponses`, a byte-exact echo of the opaque `requestState`, and a fresh request id, up to `inputRequired.maxRounds` rounds (default 10; exhaustion raises a typed `InputRequiredRoundsExceeded` error carrying the last result).
`client.callTool()` and its siblings keep returning their plain result types. `ClientOptions.inputRequired` (`autoFulfill`, `maxRounds`) configures the driver; manual mode is `autoFulfill: false` plus the per-call `allowInputRequired: true` request option and the
`withInputRequired()` schema wrapper. Retried requests surface their `inputResponses` to server handlers as bare response objects — entries in a wrapped `{method, result}` shape are dropped and reported via `ctx.mcpReq.droppedInputResponseKeys`. 2025-era behavior is unchanged:
the legacy wire has no `input_required` vocabulary and the legacy server-to-client request flow is untouched.
