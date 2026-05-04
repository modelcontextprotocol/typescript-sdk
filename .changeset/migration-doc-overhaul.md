---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Reframe the v1→v2 migration guide around the "most servers: just bump `@modelcontextprotocol/sdk` to ^2" path. Adds a TL;DR section, a Prerequisites section (zod ^4.2.0, `moduleResolution`, bun cache), transitive-v1-dependency guidance, and a warning against extending spec-method params with custom fields.
