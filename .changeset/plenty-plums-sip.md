---
'@modelcontextprotocol/client': patch
---

Preserve the exact OAuth resource indicator from protected resource metadata when building authorization and token requests. Previously a pathless `resource` such as `https://example.com` was normalized to `https://example.com/` via `URL.href`, which breaks authorization servers that require the `resource` parameter to match the published value exactly (Microsoft Entra ID rejects it with `AADSTS9010010`). The exported OAuth helpers (`startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`, `fetchToken`, `executeTokenRequest`) now also accept a `string` for `resource`; `selectResourceURL` still returns a `URL`, and a provider's `validateResourceURL` result is used unchanged. Fixes #1968.
