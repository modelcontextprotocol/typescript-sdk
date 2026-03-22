---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

Implement generalized authentication and authorization layer for MCP servers.

- Added `Authenticator` and `BearerTokenAuthenticator` to `@modelcontextprotocol/server`.
- Integrated scope-based authorization checks into `McpServer` for tools, resources, and prompts.
- Fixed asynchronous error propagation in the core `Protocol` class to support proper 401/403 HTTP status mapping in transports.
- Updated `WebStandardStreamableHTTPServerTransport` to correctly map authentication and authorization failures to their respective HTTP status codes.
