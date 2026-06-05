---
'@modelcontextprotocol/client': patch
---

Always send the OAuth `resource` parameter, falling back to the canonical server URI when Protected Resource Metadata (RFC 9728) is absent. Previously `selectResourceURL` returned `undefined` whenever PRM discovery failed, omitting `resource` from `/authorize` and `/token`
requests. The MCP authorization spec requires clients to send this parameter "regardless of whether authorization servers support it".
