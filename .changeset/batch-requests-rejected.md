---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Reject JSON-RPC batch request bodies in the streamable HTTP transport. Batches were removed from the MCP protocol, so the server now answers an array body with 400 Invalid Request, and the client rejects array response bodies from servers.
