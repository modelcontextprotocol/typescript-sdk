---
'@modelcontextprotocol/client': patch
---

Fix: validate `clientMetadataUrl` at construction time (fail-fast)

`OAuthClientProvider` implementations that supply a `clientMetadataUrl` now have it
validated immediately when the transport is constructed rather than at the first auth
attempt. Invalid URLs throw synchronously, making misconfiguration easier to catch
during development instead of surfacing as a runtime error mid-flow.
