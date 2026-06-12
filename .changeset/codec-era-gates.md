---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `SdkErrorCode.MethodNotSupportedByProtocolVersion`: a typed local error raised before anything reaches the transport when a spec method is sent toward a peer whose negotiated protocol version's wire era does not define it (for example `tasks/get` toward a 2026-07-28 peer). The protocol layer now resolves a per-era wire codec for every exchange — from the client's negotiated version, the server's per-request classification, or the legacy default — and resolves per-method schemas at dispatch time instead of registration time. Behavior on existing (2025-era) connections is unchanged.
