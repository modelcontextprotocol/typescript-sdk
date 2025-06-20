# Changelog

## [Unreleased]

### Added
- Client-level request identifiers feature:
  - Added optional `identifiers` field to `ClientOptions` for setting client-wide identifiers
  - Added optional `identifiers` field to `CallToolRequest` schema for per-request identifiers
  - Added identifier merging logic in client's `callTool` method with request-level precedence
  - Added `IdentifierForwardingConfig` to `ServerOptions` for configuring identifier forwarding
  - Added `forwardIdentifiersAsHeaders` method to `McpServer` for converting identifiers to HTTP headers
  - Added `EnhancedRequestHandlerExtra` interface with identifiers and helper methods
  - Added server-side security validation with key format and value content filtering
  - Added configurable identifier limits with deterministic truncation behavior
  - Added ASCII-only value validation for HTTP header safety
  - Added optional whitelist filtering via `allowedKeys` configuration
  - Added comprehensive test suite with 11 security and functionality test scenarios
  - Added example demonstrating client-level and request-level identifiers

### Security
- Identifier forwarding is disabled by default for security
- Implemented multi-layer validation to prevent header injection attacks
- Added input sanitization for keys (alphanumeric, hyphens, underscores only)
- Added control character filtering for values
- Added configurable limits for identifier count and value length

### Developer Experience  
- Zero breaking changes - fully backward compatible with existing code
- Added helper method `applyIdentifiersToRequestOptions()` for easy HTTP request enhancement
- Added rich TypeScript types with proper interface extensions
- Clean protocol design - only includes identifiers field when non-empty