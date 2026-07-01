---
'@modelcontextprotocol/client': patch
---

Accumulate scopes (union) when re-authorizing after a `403 insufficient_scope` step-up challenge (SEP-2350). Previously the challenged scopes replaced the requested scope, so per-operation challenges dropped previously granted permissions. The client now requests the union of
previously granted scopes (from stored tokens), previously requested scopes, protected resource metadata scopes, provider-configured default scopes, and the newly challenged scopes, using the existing exported `computeScopeUnion` helper.
