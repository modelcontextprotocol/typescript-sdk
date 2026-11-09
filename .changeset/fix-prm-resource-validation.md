---
'@modelcontextprotocol/client': patch
---

Validate protected resource metadata identity before using its authorization servers or caching it (RFC 9728 §3.3). Challenge and path-specific discovery must identify the requested resource; root well-known fallback must identify the root resource. OAuth authorization, code exchange, and refresh continue to send a valid metadata resource unchanged.

Previously accepted parent-path resources, differing queries, and differing trailing path slashes are now rejected, including when `validateResourceURL` is supplied. That hook still selects the outgoing resource after metadata validation. The shared `checkResourceAllowed` path-containment helper is unchanged.

Persist the complete discovery state, including the optional `resourceMetadataRootFallback` marker. Cached metadata is revalidated before use; old root-resource caches without discovery provenance are rediscovered.
