---
'@modelcontextprotocol/client': patch
---

Send the granted `scope` on refresh-token requests (RFC 6749 §6). `refreshAuthorization()` accepts a new optional `scope` and preserves the granted scope on its result when the response omits it (RFC 6749 §5.1); the built-in `auth()` flow sends exactly the granted scope recorded on the stored tokens (omitting the parameter when none is recorded). Fixes token refresh against authorization servers that require the parameter, e.g. Microsoft Entra ID rejecting scope-less refreshes with `AADSTS90009` when the client application is also the resource (#2718).
