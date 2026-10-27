---
'@modelcontextprotocol/sdk': patch
---

The step-up of a `403 insufficient_scope` now starts a new authorization when the token lacks a challenged scope, instead of refreshing the token. A refresh cannot add scopes (RFC 6749 §6), so the retry got the same 403 and failed with "Server returned 403 after trying
upscoping". The new authorization asks for the challenged scopes and for the scopes requested and granted before. `auth()` accepts a new `forceReauthorization` option. Fixes #2255.
