---
'@modelcontextprotocol/client': patch
---

Keep previously granted OAuth scopes when a `401` leads to a new authorization. Automatic `401` handling in Streamable HTTP and legacy SSE adds the token's granted scope and every scope the transport has challenged or requested to the scope it selects; `withOAuth` adds the token's granted scope. The refresh token is still tried first, values the authorization server does not advertise in `scopes_supported` are dropped, and non-interactive providers (no `redirectUrl`) retain nothing. A step-up scope now joins the transport's scope only once tokens for it are saved, so a refused or declined scope is not requested again. `auth()` accepts a new `priorScope` option for this.
