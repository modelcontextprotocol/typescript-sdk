---
'@modelcontextprotocol/server': patch
---

Return a generic `-32602` Invalid params error when `resources/read` receives a syntactically invalid URI. The error data includes `{ uri, reason: 'invalid_uri' }`, so clients do not confuse malformed URIs with the exact `{ uri }` discriminator used for resource-not-found.
