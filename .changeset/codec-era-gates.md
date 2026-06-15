---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `SdkErrorCode.MethodNotSupportedByProtocolVersion`: a typed local error raised before anything reaches the transport when a spec method is sent toward a peer whose negotiated protocol version's wire era does not define it (for example `tasks/get` toward a 2026-07-28 peer). The protocol layer now resolves a per-era wire codec from the connection's negotiated protocol version (instance state on `Client`/`Server`, with the legacy era as the pre-negotiation default) and resolves per-method schemas at dispatch time instead of registration time; an edge classification on an inbound message is validated against that instance era, and a mismatch is rejected as an entry/routing error. Behavior on existing (2025-era) connections is unchanged.
