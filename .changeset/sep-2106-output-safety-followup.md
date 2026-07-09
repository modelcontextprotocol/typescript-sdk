---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': minor
---

Type-check `structuredContent` returned by `McpServer.registerTool` handlers against the declared `outputSchema`. Bound schema depth and subschema count in the built-in validators, and reject non-local references before compilation; custom validators retain control of their own reference and resource policies.
