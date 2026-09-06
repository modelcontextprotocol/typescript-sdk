---
'@modelcontextprotocol/client': patch
---

Deduplicate concurrent OAuth flows only when the provider and request options match. Ordinary
calls with different resources, scopes, discovery validation settings, metadata URLs, or fetch
functions run serially and read credentials after the previous operation settles, including failures.
Authorization-code exchanges and forced reauthorization still bypass this queue.

Add the optional `OAuthClientProvider.withAuthTransaction` hook so hosts can protect a complete
auth operation, including credential invalidation and recovery retries, with their own lock.
Code exchanges and forced reauthorization also invoke the hook independently.

Treat `error_description: null` as an omitted description when parsing an OAuth error response.
This allows `invalid_grant` recovery without relaxing the public OAuth error schema or accepting
malformed values in other fields.
