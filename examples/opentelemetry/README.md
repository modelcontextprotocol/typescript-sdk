# opentelemetry

Trace and measure MCP traffic with OpenTelemetry. Both processes register an OpenTelemetry SDK and configure nothing on the MCP side; the client's `tools/call` span carries its trace context to the server in `params._meta`, so the server span and anything the tool does land in the same trace. The client asserts the trace crossed the wire, the span parenting on both sides, and that `mcp.client.operation.duration` was recorded.

```bash
pnpm --filter @mcp-examples/opentelemetry client
```

Sample output (ids differ per run):

```
trace 4bf92f3577b34da6a3ce929d0e0e4736
  invoke_agent (client process)
    tools/call trace-info (client process)
      tools/call trace-info (server process)
```

The server and client keep spans in memory to stay self-contained. In an application, add a span processor with an exporter (for example `OTLPTraceExporter`) to the tracer provider. See [the OpenTelemetry guide](../../docs/advanced/opentelemetry.md).
