---
shape: how-to
---

# OpenTelemetry

`Client`, `McpServer` and `Server` emit OpenTelemetry spans and metrics for every MCP request and notification, following the [OpenTelemetry semantic conventions for MCP](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md). Register an OpenTelemetry SDK and they show up.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#sdk_setup"
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

// Swap the in-memory exporter for an OTLP exporter to send spans to a backend.
const exporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(tracerProvider);
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));
```

::: warning Experimental
The MCP semantic conventions are still in development. Span and attribute names can change in a minor release.
:::

## Register an OpenTelemetry SDK

The SDK packages talk to the OpenTelemetry API, which does nothing until an application registers an SDK. Without one, nothing is recorded and nothing is added to `params._meta`.

```sh
npm install @opentelemetry/api @opentelemetry/sdk-trace @opentelemetry/context-async-hooks @opentelemetry/core
```

The server needs no telemetry configuration of its own.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#server_traced"
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'weather', version: '1.0.0' });

server.registerTool('get-weather', { inputSchema: z.object({ city: z.string() }) }, async ({ city }) => {
    // Spans started here are children of the "tools/call get-weather" server span.
    const forecast = await trace.getTracer('weather').startActiveSpan('fetch forecast', async span => {
        span.end();
        return 'sunny';
    });
    return { content: [{ type: 'text', text: `${city}: ${forecast}` }] };
});
```

The context manager is what makes the MCP span active inside your handlers, so spans you start there nest under it.

## See the spans

Make a call inside a span of your own, here an agent run.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#callTool_traced"
await trace.getTracer('agent').startActiveSpan('invoke_agent', async agentSpan => {
    await client.callTool({ name: 'get-weather', arguments: { city: 'Lisbon' } });
    agentSpan.end();
});
```

The client's span carries its trace context to the server in `params._meta`, so both sides land in one trace:

```
invoke_agent (internal)
  tools/call get-weather (client)
    tools/call get-weather (server)
      fetch forecast (internal)
```

The server span comes from the `@modelcontextprotocol/server` instrumentation scope (client spans from `@modelcontextprotocol/client`) and carries the conventions' attributes, plus `jsonrpc.request.id`, left out here:

```
@modelcontextprotocol/server {
  'mcp.method.name': 'tools/call',
  'mcp.protocol.version': '2025-11-25',
  'gen_ai.operation.name': 'execute_tool',
  'gen_ai.tool.name': 'get-weather'
}
```

::: info
Any SDK that follows [SEP-414](https://modelcontextprotocol.io/community/seps/414-request-meta) reads the same `traceparent`, `tracestate` and `baggage` keys, so a Python or C# peer joins the trace too.
:::

## Read the duration metrics

Register a meter provider and each instance records `mcp.client.operation.duration` for what it sends and `mcp.server.operation.duration` for what it receives, in seconds, with the conventions' bucket boundaries. The tool call above recorded:

```
mcp.client.operation.duration (s) {
  'mcp.method.name': 'tools/call',
  'mcp.protocol.version': '2025-11-25',
  'gen_ai.operation.name': 'execute_tool',
  'gen_ai.tool.name': 'get-weather'
}
```

Metrics never carry session ids, request ids or resource URIs. A server records a method it has no handler for as `_OTHER`, and leaves an unknown tool or prompt name out, so a client can't grow your metric cardinality.

## Know what counts as an error

Failed operations set `error.type` and an `ERROR` status:

- A JSON-RPC error records its code, such as `-32603`, in `error.type` and `rpc.response.status_code`. On the server, `-32700`, `-32600`, `-32601`, `-32602` and `-32002` mean the caller sent something unservable and are not errors.
- A tool result with `isError: true` records `tool_error`. Its content stays out of the span.
- Local failures record `timeout`, `cancelled`, `connection_closed`, or the SDK error code (`SEND_FAILED`, `INVALID_RESULT`).
- A handler that throws something other than a `ProtocolError` also gets an exception event on the server span.

Spans never carry tool arguments, tool results or prompt arguments.

## Serve over HTTP

With HTTP instrumentation active too, the MCP server span stays a child of the client's MCP span and links to the HTTP server span. `createMcpHandler` needs nothing extra.

::: tip
Already tracing MCP with another tool, such as Sentry's MCP integration? Drop one of the two to avoid duplicate spans: filter the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` instrumentation scopes out in your SDK's span processor, or turn off the other integration.
:::

The `examples/opentelemetry` story runs a traced client and server in separate processes over stdio and Streamable HTTP, and checks the trace crosses the wire.

## Recap

- Register an OpenTelemetry SDK; `Client`, `McpServer` and `Server` need no configuration.
- Without a registered SDK, nothing is recorded and `params._meta` is untouched.
- Trace context travels in `params._meta`, so client and server spans join one trace and handler spans nest under the server span.
- Each instance records `mcp.client.operation.duration` and `mcp.server.operation.duration` with low-cardinality attributes.
- Spans never carry tool arguments, tool results or prompt arguments.
