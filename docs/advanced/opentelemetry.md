---
shape: how-to
---

# OpenTelemetry

`@modelcontextprotocol/otel` traces and measures every MCP request and notification, following the [OpenTelemetry semantic conventions for MCP](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md). Pass `openTelemetry()` as the `instrumentation` option.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#openTelemetry_server"
import { openTelemetry } from '@modelcontextprotocol/otel';
import { McpServer } from '@modelcontextprotocol/server';
import { trace } from '@opentelemetry/api';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation: openTelemetry() });

server.registerTool('get-weather', { inputSchema: z.object({ city: z.string() }) }, async ({ city }) => {
    // Spans started here are children of the "tools/call get-weather" server span.
    const forecast = await trace.getTracer('weather').startActiveSpan('fetch forecast', async span => {
        span.end();
        return 'sunny';
    });
    return { content: [{ type: 'text', text: `${city}: ${forecast}` }] };
});
```

::: warning Experimental
The `instrumentation` option and `@modelcontextprotocol/otel` are experimental, and so are the MCP semantic conventions they follow. Span and attribute names can change in a minor release.
:::

## Install the package

The package uses only the OpenTelemetry API. Your application brings the SDK and an exporter.

```sh
npm install @modelcontextprotocol/otel @opentelemetry/api @opentelemetry/sdk-trace-node
```

## Start the OpenTelemetry SDK

Register a tracer provider once, before any MCP traffic. `NodeTracerProvider.register()` also installs the W3C propagators and an `AsyncLocalStorage` context manager, which makes the MCP span active inside your handlers.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#sdk_setup"
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

// Swap the in-memory exporter for an OTLP exporter to send spans to a backend.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
// Registers the tracer provider, the W3C propagators and an AsyncLocalStorage context manager.
provider.register();
```

Without a registered SDK, `openTelemetry()` records nothing and leaves `params._meta` untouched.

## Trace a client

The same option works on `Client`.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#openTelemetry_client"
import { Client } from '@modelcontextprotocol/client';

const client = new Client({ name: 'agent', version: '1.0.0' }, { instrumentation: openTelemetry() });
```

Make a call inside a span of your own, here an agent run.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#callTool_traced"
await trace.getTracer('agent').startActiveSpan('invoke_agent', async agentSpan => {
    await client.callTool({ name: 'get-weather', arguments: { city: 'Lisbon' } });
    agentSpan.end();
});
```

The client's span carries its trace context to the server in `params._meta`, so both sides land in one trace. The span the tool started nests under the server span:

```
invoke_agent (internal)
  tools/call get-weather (client)
    tools/call get-weather (server)
      fetch forecast (internal)
```

The server span carries the conventions' attributes (plus `jsonrpc.request.id`, left out here):

```
{
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

`openTelemetry()` records `mcp.client.operation.duration` for what an instance sends and `mcp.server.operation.duration` for what it receives, in seconds, with the conventions' bucket boundaries. Register a meter provider the same way as the tracer provider. The tool call above recorded:

```
mcp.client.operation.duration (s) {
  'mcp.method.name': 'tools/call',
  'mcp.protocol.version': '2025-11-25',
  'gen_ai.operation.name': 'execute_tool',
  'gen_ai.tool.name': 'get-weather'
}
```

Metrics never carry session ids, request ids or resource URIs. A server records a method it has no handler for as `_OTHER`, and leaves an unknown tool or prompt name out, so a client can't grow your metric cardinality.

## Serve over HTTP

`createMcpHandler` builds a server per request. Create the instrumentation once and share it.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#openTelemetry_createMcpHandler"
import { createMcpHandler } from '@modelcontextprotocol/server';

const instrumentation = openTelemetry();

const handler = createMcpHandler(() => {
    const perRequest = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation });
    // perRequest.registerTool(...)
    return perRequest;
});
```

When HTTP instrumentation is active too, the MCP server span stays a child of the client's MCP span and links to the HTTP server span.

## Know what counts as an error

Failed operations set `error.type` and an `ERROR` status:

- A JSON-RPC error records its code, such as `-32603`, in `error.type` and `rpc.response.status_code`. On the server, `-32700`, `-32600`, `-32601`, `-32602` and `-32002` mean the caller sent something unservable and are not errors.
- A tool result with `isError: true` records `tool_error`. Its content stays out of the span.
- Local failures record `timeout`, `cancelled`, `connection_closed`, or the SDK error code (`SEND_FAILED`, `INVALID_RESULT`).
- A handler that throws something other than a `ProtocolError` also gets an exception event on the server span.

## Record tool arguments and results

By default spans carry no tool arguments, tool results or prompt arguments. Turn them on with `captureContent` when you need them for debugging.

```ts source="../../examples/guides/advanced/opentelemetry.examples.ts#openTelemetry_captureContent"
const debugInstrumentation = openTelemetry({ captureContent: true });
```

::: warning
Captured content goes to your telemetry backend as is. Tool arguments and results can hold personal data or secrets.
:::

The `examples/opentelemetry` story runs a traced client and server in separate processes over stdio and Streamable HTTP, and checks the trace crosses the wire.

## Recap

- `openTelemetry()` from `@modelcontextprotocol/otel` goes in the `instrumentation` option of `Client`, `McpServer` or `Server`.
- Your application starts the OpenTelemetry SDK; without one nothing is recorded.
- Trace context travels in `params._meta`, so client and server spans join one trace and handler spans nest under the server span.
- Each instance records `mcp.client.operation.duration` and `mcp.server.operation.duration` with low-cardinality attributes.
- Tool arguments and results are only recorded with `captureContent: true`.
