---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Streamable HTTP servers route draft-protocol requests to a stateless dispatch path (not yet implemented; answers with a clear error). Stdio servers route the same way, keying on the request's `io.modelcontextprotocol/protocolVersion` `_meta` claim — and only when the server explicitly lists the draft version as supported. Existing behavior for all current traffic is unchanged.
