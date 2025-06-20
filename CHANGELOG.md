# Changelog

## [Unreleased]

### Added
- Client-level request identifiers feature:
  - Added optional `identifiers` field to `ClientOptions` for setting client-wide identifiers
  - Added optional `identifiers` field to `CallToolRequest` schema for per-request identifiers
  - Added identifier merging logic in client's `callTool` method
  - Added `IdentifierForwardingConfig` to `ServerOptions` for configuring identifier forwarding
  - Added `forwardIdentifiersAsHeaders` method to `McpServer` for converting identifiers to HTTP headers
  - Added `EnhancedRequestHandlerExtra` interface with identifiers and helper methods
  - Added example demonstrating client-level and request-level identifiers
