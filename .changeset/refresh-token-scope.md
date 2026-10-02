---
'@modelcontextprotocol/sdk': patch
---

Send the `scope` parameter on refresh-token requests.

`refreshAuthorization()` accepts a new optional `scope` and sets it on the request body when it is
a non-empty string. The `auth()` flow sends exactly the granted scope recorded on the stored
tokens. When no granted scope is recorded, no `scope` parameter is sent, so the wire shape is
unchanged by default.

Omitting `scope` on a refresh grant is legal per RFC 6749 section 6, but some authorization servers
require it to resolve the target resource. Microsoft Entra ID rejects a scope-less refresh with
`AADSTS90009` whenever the OAuth client application is also the resource, a common setup for
Entra-protected MCP servers. Initial authorization succeeds because the scope travels on the
authorize request, so affected clients work until the first access-token expiry and then wedge.

Backport of the v2 fix for #2718.
