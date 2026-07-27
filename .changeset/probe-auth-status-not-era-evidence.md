---
'@modelcontextprotocol/client': patch
---

The version-negotiation probe no longer misclassifies auth-protected or
failing servers as legacy. Auth status is never era evidence: a 401 or 403
rejection of the `server/discover` probe now surfaces as a typed
authorization failure — an `SdkHttpError` with code `ClientHttpAuthentication`
(401) or `ClientHttpForbidden` (403), carrying the HTTP status, reason
phrase, and response text — instead of triggering the legacy `initialize`
fallback (which put a doomed `initialize` on the wire) or, under `pin` mode,
the false "server did not offer pinned protocol version" diagnostic. The
codes are deliberately not `EraNegotiationFailed`, so era-recovery flows
keyed on that code cannot persist a verdict for an unauthorized exchange. A
5xx rejecting the probe is a server failure and now also rejects typed
(`SdkHttpError(EraNegotiationFailed)`) instead of demoting a mid-deploy
modern server to legacy — the legacy fallback now fires only on the 4xx
shapes the spec licenses.

With an `authProvider`, a `401` (and a `403` `insufficient_scope` challenge) runs the transport's auth flow first — a plain `403` rejects the same as without a provider — and whatever
escapes it propagates unchanged, identity intact: the HTTP transports stamp
errors at their auth seams (the `token()` read, `onUnauthorized` including
custom callbacks, the 403 step-up flow, and their own auth-failure
constructions), so `UnauthorizedError` for `finishAuth()`, the flow's typed
failures (`OAuthError`, `InsufficientScopeError`, the
401-after-re-authentication diagnostic), and even an untyped `TypeError`
thrown inside the flow all reach the caller as thrown — never rewrapped,
never consumed by the probe's browser CORS heuristic as legacy-era evidence.
