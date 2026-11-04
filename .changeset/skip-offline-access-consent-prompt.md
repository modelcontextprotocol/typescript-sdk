---
'@modelcontextprotocol/client': patch
---

Add `OAuthClientProvider.skipOfflineAccessConsentPrompt` (and the matching `startAuthorization()` option) so a client can omit the `prompt=consent` the SDK adds when the requested scope includes `offline_access`. Default behavior is unchanged. This unblocks authorization servers such as Microsoft Entra ID tenants that have user consent disabled and admin consent granted, where a forced consent prompt fails with `AADSTS90095` for non-admin users.
