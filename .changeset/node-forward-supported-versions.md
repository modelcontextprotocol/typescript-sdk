---
'@modelcontextprotocol/node': patch
---

Forward `setSupportedProtocolVersions` from `NodeStreamableHTTPServerTransport` to the wrapped Web Standard transport. Previously a server's `supportedProtocolVersions` option never reached the Node adapter's `MCP-Protocol-Version` header validation, which silently kept
validating against the default version list.
