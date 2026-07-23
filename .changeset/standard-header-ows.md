---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
---

Strip RFC 9110 optional whitespace around inbound `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` values before classifying and validating modern HTTP requests. This keeps valid requests portable across Fetch runtimes that expose raw leading or trailing SP/HTAB through `Headers.get()`.
