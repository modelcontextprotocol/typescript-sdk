---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Drop the never-released `2024-10-07` protocol version from `SUPPORTED_PROTOCOL_VERSIONS`. The version does not appear in any released MCP spec revision, and advertising it let clients negotiate a protocol version no other SDK recognizes.
