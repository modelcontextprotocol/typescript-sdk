---
'@modelcontextprotocol/core': major
'@modelcontextprotocol/client': major
'@modelcontextprotocol/server': major
---

Split the wire layer into per-era codecs and make protocol-revision deletions physical. Deliberate wire/schema behavior changes (see docs/migration/support-2026-07-28.md "Per-era wire codecs"):

- `resultType` is no longer modeled by any neutral wire schema: `EmptyResultSchema` (strict) now rejects `{resultType}` bodies; on 2025-era connections a foreign `resultType` is stripped before validation instead of rejected; the member exists only inside the 2026-era codec, which requires it.
- `CallToolResult.content` / `ToolResultContent.content` are required at the wire boundary (`content.default([])` removed): handler results without `content` are rejected with `-32602` instead of silently defaulted, and content-less wire results fail the client parse loudly.
- Custom (3-arg) handlers now receive `_meta` minus the reserved envelope keys instead of having it deleted before params validation.
- `specTypeSchemas` re-scoped to the neutral model: result validators no longer accept `resultType`; task message-type validators and `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed).
- Role aggregate types/schemas (`ClientRequest`, `ServerResult`, …) no longer carry task vocabulary; the deprecated `Task*` types remain importable unchanged.
- Era-mismatched spec methods fail physically: inbound era-deleted methods get `-32601` even with a handler registered; outbound sends throw `SdkErrorCode.MethodNotSupportedByProtocolVersion` locally.
- Value guards (`isCallToolResult`, …) are documented as neutral-shape consumer checks, not wire validators.
