---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `setCustomRequestHandler` / `setCustomNotificationHandler` / `sendCustomRequest` / `sendCustomNotification` (plus `remove*` variants) on `Protocol` for non-standard JSON-RPC methods. Restores typed registration for vendor-specific methods (e.g. `mcp-ui/*`) that #1446/#1451 closed off, without reintroducing class-level generics. Handlers share the standard dispatch path (context, cancellation, tasks); a collision guard rejects standard MCP methods.
