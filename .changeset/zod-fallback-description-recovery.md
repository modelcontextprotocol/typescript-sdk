---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Recover `.describe()` descriptions when converting schemas from zod versions without `~standard.jsonSchema` (zod 4.0/4.1 and the zod@3.25.x `zod/v4` subpath). The bundled-converter fallback previously dropped all registry-held metadata, silently advertising tool schemas without
any field documentation. The fallback warning can now be silenced with `MCP_SUPPRESS_ZOD_FALLBACK_WARNING=1` and mentions what is and isn't preserved.
