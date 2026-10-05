---
'@modelcontextprotocol/server-legacy': patch
---

`requireBearerAuth` in `@modelcontextprotocol/server-legacy` takes the optional `expectedResource` that `@modelcontextprotocol/server` 2.3.0 and `@modelcontextprotocol/sdk` 1.32.0 added: the resource the token must be issued for (its audience), usually the server's URL. When it is set, a token is accepted only if the verifier reports that value in `AuthInfo.resource`; the two are compared as strings, ignoring a fragment and one trailing slash. A token reported for another value, or for none, is answered `401 invalid_token` with the usual `WWW-Authenticate` challenge. When it is not set, nothing changes. The package stays frozen otherwise; this option is added so that its `requireBearerAuth` matches the 1.x middleware it is a copy of.
