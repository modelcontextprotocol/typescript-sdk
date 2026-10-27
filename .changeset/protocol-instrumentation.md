---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

`Client`, `Server` and `McpServer` now emit OpenTelemetry spans and `mcp.client.operation.duration` / `mcp.server.operation.duration` histograms for every MCP request and notification except `notifications/message`, following the OpenTelemetry semantic conventions for MCP, and propagate W3C trace context through `params._meta` (SEP-414). There is nothing to configure: register an OpenTelemetry SDK and MCP traffic shows up. Without one, the OpenTelemetry API is a no-op, nothing is recorded and messages are unchanged.

`@opentelemetry/api` (`^1.9.0`) is a new peer dependency of `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, so the SDK uses the same copy as the application's OpenTelemetry SDK. npm, pnpm and Bun install it automatically; with Yarn PnP add it to your dependencies.

What changes for applications that already run an OpenTelemetry SDK:

- MCP spans and metrics appear under the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` instrumentation scopes. To drop them (for example when Sentry's MCP integration already traces MCP), filter those scopes in your SDK.
- Outgoing requests and notifications carry the keys your propagator writes in `params._meta`: `traceparent` and `tracestate`, and `baggage` if your propagator includes W3C Baggage (the `NodeSDK` default), in which case baggage entries reach MCP peers, including third-party servers. Register `W3CTraceContextPropagator` alone to send trace context only.
- Servers that validate a custom method's params with a strict schema need an optional `_meta` member, as they already do for callers that pass `onprogress`.

Spans do not record tool arguments, tool results or prompt arguments. They do record JSON-RPC error messages, handler exception messages and resource URIs. The span and attribute names are experimental while the MCP semantic conventions are in development.
