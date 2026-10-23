---
'@modelcontextprotocol/sdk': minor
---

`requireBearerAuth` takes a new optional `expectedResource`, which makes it accept only tokens issued for this resource (the token's audience). Set it to the value your authorization server puts into tokens meant for this server, usually the server's URL. When it is set, a token
is accepted only if the verifier reports that value in `AuthInfo.resource`; the two are compared as strings, ignoring a fragment and one trailing slash. A token reported for another value, or for none, is answered `401 invalid_token` with the usual `WWW-Authenticate` challenge.
When it is not set, nothing changes. To use it, pass `expectedResource` and have `verifyAccessToken` fill `AuthInfo.resource`, for example from the `aud` claim.
