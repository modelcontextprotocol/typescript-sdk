---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': minor
---

Add request-time OAuth scope challenges for tools, resources, resource templates,
and prompts. Each primitive's `scopeChallenge` callback receives the parsed
request and verified authentication info, then either continues or returns the
exact scope set for an `insufficient_scope` response. `requireScopes` provides a
small helper for static all-of checks.

`createMcpHandler` and Streamable HTTP transports return HTTP 403 with an
`insufficient_scope` challenge before handler execution or SSE setup. The
preflight is active whenever a registered primitive carries a `scopeChallenge`
callback — there is no handler- or transport-level configuration. The
challenge's `WWW-Authenticate` header is built by the same formatter as the
bearer-auth 401/403 answers, and its `resource_metadata` parameter is derived
from the verified `AuthInfo`: `requireBearerAuth` / `verifyBearerToken` now
stamp their configured `resourceMetadataUrl` onto the `AuthInfo` they return
(new optional `AuthInfo.resourceMetadataUrl` field), with a fallback to the
well-known location for the token's RFC 8707 `resource` identifier; the
parameter is omitted when neither is available.
