---
'@modelcontextprotocol/server': patch
---

Preserve trailing slashes on non-root resource paths in `getOAuthProtectedResourceMetadataUrl`, matching client discovery. The `oauthMetadataResponse` handler serves the generated URL and retains its existing tolerance for a single trailing slash.
