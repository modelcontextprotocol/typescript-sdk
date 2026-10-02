---
'@modelcontextprotocol/sdk': patch
---

Prevent double-prefixing error messages when a handler throws `McpError` by serializing bare messages on the wire and avoiding duplicate prefixes in `McpError.fromError`.
