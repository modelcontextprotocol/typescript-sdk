---
'@modelcontextprotocol/server-legacy': patch
---

Preserve the OAuth `state` parameter on authorization error redirects. In
`authorizationHandler`, `state` was read out of the Phase-2 parse result after that
parse had already been checked, so any validation failure — a missing `code_challenge`,
an unsupported `code_challenge_method`, a non-URL `resource` — threw before the
assignment ran, and `createErrorRedirect` then built the redirect with `state` still
`undefined` and omitted the parameter.

RFC 6749 §4.1.2.1 requires `state` on the error response whenever the authorization
request carried one. Without it a client performing the standard CSRF check has to
reject the callback, so the `invalid_request` describing the actual problem never
reaches the user: the failure surfaces as a state mismatch on the client instead, on
the error path, where the diagnostic matters most.

`state` is now captured from the raw request parameters before validation runs. The
success path is unchanged, and a request that carried no `state` still gets an error
redirect without one.
