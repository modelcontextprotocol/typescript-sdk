---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Add generic SEP-2133 extension helpers: `McpServer.enableExtension(identifier, settings?)` / `McpServer.getClientExtension(identifier)` and the `Client` mirrors `enableExtension` / `getServerExtension` — thin convenience over `registerCapabilities` / `get*Capabilities` for the `capabilities.extensions` map. `McpRequestContext` now carries `clientCapabilities` (populated on the modern HTTP path from the validated per-request envelope) so a `createMcpHandler` factory can branch on extension support at construction time.
