---
'@modelcontextprotocol/client': patch
---

Send the `scope` parameter on refresh-token requests (RFC 6749 §6). `refreshAuthorization()` accepts a new optional `scope`, and the built-in `auth()` flow passes the granted scope recorded on the stored tokens (falling back to the scope it resolves for authorization requests). Fixes token refresh against authorization servers that require the parameter, e.g. Microsoft Entra ID rejecting scope-less refreshes with `AADSTS90009` when the client application is also the resource (#2718).
