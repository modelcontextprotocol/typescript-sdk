---
"@modelcontextprotocol/client": patch
---

Fix OAuth resource metadata URL persistence across browser redirects

Added two optional methods to `OAuthClientProvider`:
- `saveResourceMetadataUrl(url: URL)`: Saves the URL before redirect
- `resourceMetadataUrl()`: Loads the saved URL after redirect

This fixes token exchange failures in browser OAuth flows where the resource metadata URL discovered from the WWW-Authenticate header was lost during redirects.
