---
'@modelcontextprotocol/client': patch
---

Send the connection's negotiated protocol version in the `MCP-Protocol-Version`
header on OAuth metadata discovery requests. Previously every discovery request
advertised the latest legacy revision regardless of what the connection had
negotiated. `AuthOptions` and `discoverOAuthServerInfo` gain an optional
`protocolVersion`; the Streamable HTTP and SSE transports pass their negotiated
version automatically. When unset (auth before any handshake), discovery still
falls back to `LATEST_LEGACY_PROTOCOL_VERSION` — unchanged prior behavior.
