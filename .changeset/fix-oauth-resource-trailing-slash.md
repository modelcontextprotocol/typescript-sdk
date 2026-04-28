---
'@modelcontextprotocol/sdk': patch
---

Preserve the OAuth protected-resource URI without adding a trailing slash.
Previously `selectResourceURL` returned `new URL(metadata.resource).href` which
appended `/` to bare-domain URIs (e.g. `https://example.com` became
`https://example.com/`), breaking OAuth interop with Microsoft Entra ID.
Resolves #1968.
