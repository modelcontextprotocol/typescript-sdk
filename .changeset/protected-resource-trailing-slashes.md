---
'@modelcontextprotocol/client': patch
---

Preserve trailing slashes on non-root resource paths when constructing OAuth Protected Resource Metadata discovery URLs. A resource at `/mcp/` now discovers metadata at `/.well-known/oauth-protected-resource/mcp/` instead of `/.well-known/oauth-protected-resource/mcp`. Servers that relied on the stripped path should serve or redirect the preserved path, or advertise an explicit `resource_metadata` URL. Root discovery and authorization-server discovery are unchanged.
