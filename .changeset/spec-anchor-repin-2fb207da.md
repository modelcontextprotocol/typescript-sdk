---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Re-pin the 2026-07-28 draft references (spec reference types, vendored schema.json twins, example corpus) to the latest spec commit and align the 2026-era wire surface with it. Deliberate 2026-era wire behavior changes (the released 2025-11-25 surface is untouched):

- `notifications/elicitation/complete` is no longer part of the 2026-07-28 wire registry (the draft removed the notification together with `elicitationId` on URL-mode elicitation). On connections negotiated at 2026-07-28, sending it — including via `Server.createElicitationCompletionNotifier()` — now fails locally with `SdkErrorCode.MethodNotSupportedByProtocolVersion`, and inbound copies are dropped as unknown notifications. Both remain fully supported on 2025-11-25.
- `notifications/cancelled` on 2026-era connections now parses with a revision-exact schema that requires `requestId` (the draft made it required); the notification `_meta` shape types the `io.modelcontextprotocol/subscriptionId` key. 2025-era parsing is unchanged.
- The error code `-32001` emitted for HTTP header/body mismatches is now defined by the draft schema (`HEADER_MISMATCH`); the emitted behavior is unchanged (documentation only).

No public API surface changes; the regenerated reference artifacts are internal/test-only.
