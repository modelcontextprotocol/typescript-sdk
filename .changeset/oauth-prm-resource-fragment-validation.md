---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
---

Tighten OAuth Protected Resource Metadata `resource` validation per RFC 8707 §2: identifiers containing a fragment component are now rejected by `OAuthProtectedResourceMetadataSchema`. The error message thrown by `selectResourceURL` on origin/path mismatch now points at `OAuthClientProvider.validateResourceURL` as the supported override for non-URL RFC 8707 indicators (e.g. `urn:`, `api://`) or identifiers served from a different origin. The `validateResourceURL` JSDoc has been clarified to document this override use case and reference RFC 9728 §3.3 / §7.3 for the strict-default rationale.
