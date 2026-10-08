---
'@modelcontextprotocol/sdk': patch
---

Preserve the `state` parameter on OAuth error redirects per RFC 6749 §4.1.2.1. When an authorization request included `state` and the server redirects back with an error — for example because a parameter failed schema validation, like a missing `code_challenge` — the redirect
previously dropped `state`, so the client could not correlate the response and its CSRF check could not run. `state` is now recovered from the raw request parameters (when it is a string) before the error redirect is built. Fixes #2773.
