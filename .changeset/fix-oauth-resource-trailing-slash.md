---
'@modelcontextprotocol/client': patch
---

Preserve the exact resource URI from protected resource metadata when building OAuth requests. Previously, a pathless URI like `https://example.com` was normalized to `https://example.com/` via `URL.href`, breaking providers such as Microsoft Entra ID that require the `resource` parameter to exactly match the value in metadata.
