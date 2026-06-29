---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Align the 2026-07-28 protocol error codes to the spec renumber: `HeaderMismatch` is now `-32020` (was `-32001`), `MissingRequiredClientCapability` is now `-32021` (was `-32003`), and `UnsupportedProtocolVersion` is now `-32022` (was `-32004`). These codes are part of the draft 2026-07-28 protocol revision only and have never appeared on a 2025-era wire — the 2025 serving paths and the SDK-conventional `-32001` (`Session not found`) on the stateful Streamable HTTP transport are unchanged. `ProtocolErrorCode.MissingRequiredClientCapability`, `ProtocolErrorCode.UnsupportedProtocolVersion`, the `HEADER_MISMATCH_ERROR_CODE` constant, and the `HEADER_MISMATCH` / `MISSING_REQUIRED_CLIENT_CAPABILITY` / `UNSUPPORTED_PROTOCOL_VERSION` spec-type constants now carry the renumbered values; the `UnsupportedProtocolVersionError` and `MissingRequiredClientCapabilityError` classes (and `ProtocolError.fromError` recognition) follow. The client probe classifier recognizes `-32022` for the corrective continuation and the SEP-2243 one-refresh-on-miss retry triggers on `-32020`.
