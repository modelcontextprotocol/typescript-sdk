---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': patch
---

Support `application_type` client metadata with native/web inference for dynamic client registration (SEP-837)

Per the MCP authorization specification, clients MUST specify an appropriate `application_type` when registering dynamically: OIDC-based authorization servers default the field to `'web'`, which conflicts with native/loopback redirect URIs and can cause registration to fail.

- `OAuthClientMetadataSchema` (and therefore `OAuthClientInformationFullSchema`) now includes an optional `application_type` field, so user-supplied values are no longer stripped from registration requests or responses.
- `registerClient()` infers `application_type` when it is absent from the provided metadata: `'native'` if every redirect URI is an HTTP loopback URI (`localhost`, `127.0.0.1`, `[::1]`) or uses a custom non-http(s) scheme, otherwise `'web'`. An explicitly provided value is never overridden.
