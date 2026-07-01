---
'@modelcontextprotocol/client': patch
---

Implement SEP-2352 authorization server binding: when OAuth discovery shows the authorization server has changed since client credentials were recorded, `auth()` now invalidates the stale client registration and tokens (`invalidateCredentials('client')` / `('tokens')`) and re-registers with the new authorization server. CIMD (HTTPS URL) client IDs are portable across authorization servers when the new authorization server advertises `client_id_metadata_document_supported`; otherwise the client falls back to dynamic registration. Tokens are still invalidated when the authorization server changes. Provider implementations should persist client credentials keyed by the authorization server's `issuer` identifier.
