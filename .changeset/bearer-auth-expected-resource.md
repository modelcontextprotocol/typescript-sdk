---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/server-legacy': minor
'@modelcontextprotocol/express': patch
---

`requireBearerAuth` and `verifyBearerToken` take a new optional `expectedResource`, which makes them accept only tokens issued for this resource (the token's audience). Set it to the value your authorization server puts into tokens meant for this server, usually the server's URL. When it is set, a token is accepted only if the verifier reports that value in `AuthInfo.resource`; the two are compared as strings, ignoring one trailing slash. A token reported for another value, or for none, is answered `401 invalid_token` with the usual `WWW-Authenticate` challenge. When it is not set, nothing changes. To use it, pass `expectedResource` and have `verifyAccessToken` fill `AuthInfo.resource`, for example from the `aud` claim. The Express `requireBearerAuth` passes the option through, and `requireBearerAuth` in `@modelcontextprotocol/server-legacy/auth` accepts it as well. With Express, `@modelcontextprotocol/express` has to be upgraded to this release as well: 2.0.1 accepts the option in its types and does not pass it on, so nothing is compared.
