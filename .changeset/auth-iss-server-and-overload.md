---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server-legacy': minor
---

SEP-2468 follow-up: `transport.finishAuth()` gains a `URLSearchParams` overload (preferred) that extracts `code`/`iss`, validates `iss` first, and on mismatch throws a sanitized `IssuerMismatchError` (no callback `error_description` text); callers remain responsible for `state`. **Behavior change for `@modelcontextprotocol/server-legacy`:** `mcpAuthRouter` now advertises `authorization_response_iss_parameter_supported` (default `true`; `ProxyOAuthServerProvider` reports `false`) and the bundled authorize handler appends `iss` (RFC 9207) to every `res.redirect(...)` your `OAuthServerProvider.authorize()` issues to the client's `redirect_uri`. If your provider redirects another way (`res.writeHead`, a separate consent-page response, or a standalone `authorizationHandler({provider})` without `issuerUrl`), append `params.issuer` as `iss` yourself or set `authorizationResponseIssParameterSupported: false` — otherwise RFC 9207-compliant clients (including this SDK) will reject the callback.
