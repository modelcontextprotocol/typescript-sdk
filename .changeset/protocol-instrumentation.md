---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

`Client`, `Server` and `McpServer` now emit OpenTelemetry spans and `mcp.client.operation.duration` / `mcp.server.operation.duration` histograms for every MCP request and notification, following the OpenTelemetry semantic conventions for MCP, and propagate W3C trace context through `params._meta` (SEP-414). There is nothing to configure: register an OpenTelemetry SDK and MCP traffic shows up. Without one, the OpenTelemetry API is a no-op, nothing is recorded and messages are unchanged. Spans never carry tool arguments, tool results or prompt arguments. `@opentelemetry/api` is a new dependency of `@modelcontextprotocol/client` and `@modelcontextprotocol/server`. The span and attribute names are experimental while the MCP semantic conventions are in development.
