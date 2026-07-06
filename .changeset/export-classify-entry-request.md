---
'@modelcontextprotocol/server': minor
---

Export `classifyEntryRequest` (with its `EntryClassification` outcome type) from `@modelcontextprotocol/server`: the Request-shaped sibling of `classifyInboundRequest`, and the single classification step already behind `createMcpHandler` and `isLegacyRequest`. It takes the web-standard `Request`, extracts the HTTP method and the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, performs the entry's single body read (distinguishing an unreadable stream from a non-JSON body), and returns the full routing outcome plus a body-preserving `forwardRequest` — so hybrid deployments that need the routing reason (for example: route the legacy `initialize` handshake to a sessionful host, everything else to the stateless handler) no longer hand-assemble the classifier's fields or lose the reason to the boolean `isLegacyRequest`.
