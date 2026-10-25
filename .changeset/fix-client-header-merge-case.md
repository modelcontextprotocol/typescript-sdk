---
'@modelcontextprotocol/sdk': patch
---

Merge `requestInit.headers` into the Streamable HTTP and SSE client headers case-insensitively. A caller header that differed from a transport header only in case (for example `MCP-Protocol-Version` against `mcp-protocol-version`) used to be sent as one comma-joined value, which
the server rejects with 400. It now replaces the transport value, as a lowercase spelling already did. Fixes #2969.
