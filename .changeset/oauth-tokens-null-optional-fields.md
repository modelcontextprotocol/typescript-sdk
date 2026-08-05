---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server-legacy': patch
'@modelcontextprotocol/codemod': patch
---

OAuth token responses with null-valued optional members no longer fail
validation. Some authorization servers serialize absent optional members as
JSON `null` (nonconformant with RFC 6749 §5.1, but common in the wild);
previously `refresh_token`, `scope`, or `id_token` set to `null` failed token
exchange and refresh, and `expires_in: null` silently coerced to `0`, yielding
an instantly-expired token. The SDK's own token-response parse sites (client
token exchange/refresh, JWT-grant cross-app exchange, and the server-legacy
proxy provider) now validate with a new `OAuthTokenResponseSchema` (defined in
`@modelcontextprotocol/core`'s auth schema module and forwarded through
`core-internal`'s re-export shim) that removes
null-valued optional members before validation, so they are strictly absent
from the parsed output. The exported `OAuthTokensSchema` is unchanged — still a
plain object schema, with its `.shape`/`.extend` and input types intact: it
rejects `null` for its string-typed optional members, though `expires_in: null`
still coerces to `0` there (use `OAuthTokenResponseSchema` for raw wire
input). `refreshAuthorization` additionally hardens its merge with the
previously-stored refresh token, so an explicitly `undefined` `refresh_token`
in a parsed response can never clobber the preserved token. Note that a
stripped null `scope` is thereafter indistinguishable from an omitted `scope`
— which RFC 6749 §5.1 defines as an assertion that the granted scope is
identical to the requested scope — so consumers should not infer the granted
scope from its absence.

`OAuthTokenResponseSchema` is also a public export from
`@modelcontextprotocol/core`'s root, since the sibling v1 release exports it
from `@modelcontextprotocol/sdk/shared/auth.js` and migrating code needs a v2
home for it. The v1-to-v2 codemod's auth schema allowlist now includes the
name, so `import { OAuthTokenResponseSchema } from
'@modelcontextprotocol/sdk/shared/auth.js'` rewrites to
`@modelcontextprotocol/core` alongside the other auth schema constants.
