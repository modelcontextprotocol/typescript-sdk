---
'@modelcontextprotocol/client': patch
---

Fix resource metadata URL extraction during initial OAuth connection

Previously, when connecting to MCP servers using OAuth with separate authorization servers (like AWS Cognito, Auth0, Okta), the SDK would fail during token exchange with an "Invalid api path" error. This was because the `resourceMetadataUrl` from the WWW-Authenticate header was not being extracted during the initial connection attempt.

The fix ensures that both `StreamableHTTPClientTransport` and `SSEClientTransport` extract the resource metadata URL and scope from the WWW-Authenticate header when receiving a 401 response during the initial connection. This allows `finishAuth()` to correctly discover the authorization server's token endpoint.

This resolves issues with OAuth flows that use RFC 9728 Protected Resource Metadata and separate authorization servers.
