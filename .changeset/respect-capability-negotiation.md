---
'@modelcontextprotocol/client': patch
---

Respect capability negotiation in list methods by returning empty lists when server lacks capability

The Client now returns empty lists instead of sending requests to servers that don't advertise the corresponding capability:
- `listPrompts()` returns `{ prompts: [] }` if server lacks prompts capability
- `listResources()` returns `{ resources: [] }` if server lacks resources capability
- `listResourceTemplates()` returns `{ resourceTemplates: [] }` if server lacks resources capability
- `listTools()` returns `{ tools: [] }` if server lacks tools capability

This respects the MCP spec requirement that "Both parties SHOULD respect capability negotiation" and avoids unnecessary server warnings and traffic. The existing `enforceStrictCapabilities` option continues to throw errors when set to `true`.
