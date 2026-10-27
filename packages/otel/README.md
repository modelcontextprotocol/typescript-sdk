# `@modelcontextprotocol/otel`

OpenTelemetry tracing and metrics for the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), following the [OpenTelemetry semantic conventions for MCP](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md).

> Experimental. The `instrumentation` option and the MCP semantic conventions can change in a minor release.

## Install

```bash
npm install @modelcontextprotocol/otel @opentelemetry/api
```

The package depends only on the OpenTelemetry API. Your application starts an OpenTelemetry SDK and exporter; without one nothing is recorded.

## Usage

```ts
import { Client } from '@modelcontextprotocol/client';
import { openTelemetry } from '@modelcontextprotocol/otel';
import { McpServer } from '@modelcontextprotocol/server';

const instrumentation = openTelemetry();

const server = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation });
const client = new Client({ name: 'agent', version: '1.0.0' }, { instrumentation });
```

Every request and notification becomes a span (`CLIENT` on the sender, `SERVER` on the receiver), named `{method}` or `{method} {tool or prompt name}`. Trace context and baggage travel in `params._meta` (SEP-414), so client and server spans join one trace and spans started in a handler nest under the server span. Each instance also records `mcp.client.operation.duration` and `mcp.server.operation.duration`.

## Options

| Option           | Default                | What it does                                                      |
| ---------------- | ---------------------- | ----------------------------------------------------------------- |
| `tracerProvider` | global tracer provider | Where spans go                                                    |
| `meterProvider`  | global meter provider  | Where metrics go                                                  |
| `propagator`     | global propagator      | How trace context is written to and read from `params._meta`      |
| `captureContent` | `false`                | Record tool arguments, tool results and prompt arguments on spans |

## `error.type` values

- A JSON-RPC error code as a string, such as `-32603`. On the receiver, `-32700`, `-32600`, `-32601`, `-32602` and `-32002` are not errors.
- `tool_error`: a `tools/call` result with `isError: true`.
- `timeout`, `cancelled`, `connection_closed`.
- An SDK or system error code (`SEND_FAILED`, `INVALID_RESULT`, `ECONNREFUSED`), a standard error name (`TypeError`), or `_OTHER`.

See the [OpenTelemetry guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/opentelemetry.md) and the [`examples/opentelemetry`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/opentelemetry) story.
