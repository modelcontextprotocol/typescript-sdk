---
'@modelcontextprotocol/sdk': patch
---

The client (and the proxy server provider) now normalize JSON `null` values in optional members of OAuth token responses to absent before validation, via a new exported `OAuthTokenResponseSchema` used at the SDK's own parse sites. Some authorization servers serialize absent
optional members as `null` (nonconformant with RFC 6749 §5.1); previously such responses failed validation (`refresh_token`, `scope`, `id_token`) or coerced `expires_in: null` to `0`, an instantly-expired token. The exported `OAuthTokensSchema` is unchanged.
`refreshAuthorization` now also preserves the previous refresh token whenever the response does not carry a new one, regardless of how the `refresh_token` key is serialized.
