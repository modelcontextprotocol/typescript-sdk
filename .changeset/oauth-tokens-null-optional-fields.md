---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server-legacy': patch
---

OAuth token responses with null-valued optional members no longer fail
validation. Some authorization servers serialize absent optional members as
JSON `null` (nonconformant with RFC 6749 §5.1, but common in the wild);
previously `refresh_token`, `scope`, or `id_token` set to `null` failed token
exchange and refresh, and `expires_in: null` silently coerced to `0`, yielding
an instantly-expired token. The SDK's own token-response parse sites (client
token exchange/refresh, JWT-grant cross-app exchange, and the server-legacy
proxy provider) now validate with a new `OAuthTokenResponseSchema` that removes
null-valued optional members before validation, so they are strictly absent
from the parsed output. The exported `OAuthTokensSchema` is unchanged — still a
plain object schema that rejects nulls, with its `.shape`/`.extend` and input
types intact. `refreshAuthorization` additionally hardens its merge with the
previously-stored refresh token, so an explicitly `undefined` `refresh_token`
in a parsed response can never clobber the preserved token.
