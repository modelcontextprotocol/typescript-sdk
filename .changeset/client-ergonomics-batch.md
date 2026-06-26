---
"@modelcontextprotocol/core-internal": minor
"@modelcontextprotocol/client": minor
---

Client ergonomics batch:

- `connect()` under `versionNegotiation: 'auto'` / `{ pin }` now rejects with `UnauthorizedError` directly when the auth provider rejects the connect-time probe (previously wrapped in `SdkError(VersionNegotiationFailed).data.cause`). `UnauthorizedError` now sets `error.name`.
- New `ClientOptions.logLevel`: auto-attaches the `io.modelcontextprotocol/logLevel` `_meta` envelope key on 2026-07-28 connections, and sends a single best-effort `logging/setLevel` after a 2025-era handshake when the server advertises `logging`.
- New `ListRequestOptions.allPages`: pass `{ allPages: false }` to `listTools()` / `listPrompts()` / `listResources()` / `listResourceTemplates()` to fetch only the first page (with its raw `nextCursor`) instead of auto-aggregating.
- New `SdkErrorCode.ResultProtocolMismatch`: a 2026-07-28 peer result that omits or malforms the REQUIRED `resultType` discriminator now rejects with this code (was `InvalidResult`), so tooling can classify a non-conformant peer separately from a malformed payload.
- **Breaking (alpha-only):** `SdkErrorCode.EraNegotiationFailed` is renamed to `SdkErrorCode.VersionNegotiationFailed` (string value `'VERSION_NEGOTIATION_FAILED'`).
