---
'@modelcontextprotocol/sdk': patch
---

Respected explicit `listChanged: false` capability settings in `McpServer`. Previously, registering a tool, resource, or prompt would unconditionally overwrite `listChanged` to `true`, ignoring any explicit `false` set at construction time.
