---
'@modelcontextprotocol/client': patch
---

Clear the session ID and throw a distinguishable `SdkErrorCode.ClientHttpSessionExpired` error when the server returns HTTP 404 to a session-bound Streamable HTTP request, per the MCP spec's Session Management requirements. `terminateSession()` now also treats a 404 (session already gone) the same as the existing 405 (termination unsupported) case, resolving instead of throwing.
