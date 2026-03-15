---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

feat: expose negotiated protocol version on stdio transports

`StdioServerTransport` and `StdioClientTransport` now implement `setProtocolVersion()`
and expose a `protocolVersion` getter, making it possible to inspect the negotiated MCP
protocol version after initialization completes over stdio connections.

Previously this was only available on HTTP-based transports (where it is required for
header injection). After this change, `Client` automatically populates the version on
`StdioClientTransport`, and `Server` populates it on `StdioServerTransport` during the
`initialize` handshake — matching the existing behaviour for HTTP transports.
