---
'@modelcontextprotocol/otel': minor
---

New package: `@modelcontextprotocol/otel`. `openTelemetry()` returns an `instrumentation` for `Client`, `McpServer` and `Server` that emits spans and `mcp.client.operation.duration` / `mcp.server.operation.duration` histograms following the OpenTelemetry semantic conventions for MCP, and propagates W3C trace context and baggage through `params._meta`. Tool arguments, tool results and prompt arguments are recorded only with `captureContent: true`. Experimental while the MCP semantic conventions are in development; `@opentelemetry/api` is a peer dependency.
