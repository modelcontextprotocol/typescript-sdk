# OpenTelemetry support: design spec

- **Status:** draft for maintainer review. Implemented in [#3115](https://github.com/modelcontextprotocol/typescript-sdk/pull/3115), with the differences listed under [Implementation status](#implementation-status).
- **Tracking issue:** [#1264](https://github.com/modelcontextprotocol/typescript-sdk/issues/1264) ("OpenTelemetry integration out of the box", part of v2).
- **Related:** [#2370](https://github.com/modelcontextprotocol/typescript-sdk/pull/2370) (injectable `SdkLogger`), [#2820](https://github.com/modelcontextprotocol/typescript-sdk/pull/2820) (extensions and request middleware), [#2270](https://github.com/modelcontextprotocol/typescript-sdk/pull/2270) (SEP-414 `_meta` key constants), SEP-414, SEP-2577, SEP-2028.
- **Base:** `origin/main` at `b415e60b`. File and line references below are against that commit.

This file lives under `docs/_meta/`, which `docs/.vitepress/config.mts` excludes from the published site. It is a design document, not a user page, so the docs register in `docs/_meta/CONVENTIONS.md` does not apply to it.

## Implementation status

#3115 implements this spec in one PR (the hook, `@modelcontextprotocol/otel` with spans, propagation, operation metrics and `captureContent`, the docs page and the `examples/opentelemetry` story). It differs in three places:

- **No `connect` hook and no session metrics yet.** `Protocol` doesn't know whether it is the client or the server, and open question 7 is unresolved, so `ProtocolInstrumentation` has only `send` and `receive`. `mcp.client.session.duration` and `mcp.server.session.duration` come with the session hook.
- **Hook types are copied structurally** in `packages/otel/src/types.ts`, so the package depends on neither `client` nor `server`. `packages/otel/test/types.test.ts` checks both directions of assignability. This is one answer to open question 5.
- **No stacked PRs.** Everything is in #3115 and can be split along the [rollout](#rollout) lines if reviewers prefer.

## Summary

1. Add one experimental, dependency-free option to `ProtocolOptions`: `instrumentation?: ProtocolInstrumentation`. `Protocol` calls it at four points (outbound message, inbound message, connect, close). Nothing runs and nothing changes on the wire when the option is absent.
2. Ship the OpenTelemetry mapping as a new package, `@modelcontextprotocol/otel`, with `@opentelemetry/api` as a peer dependency. It implements the MCP semantic conventions (spans, metrics, `_meta` propagation) on top of that option. Users opt in per instance with `{ instrumentation: openTelemetry() }`.
3. Telemetry is opt-in, unlike the Python SDK. Turning it on by default would add `_meta` keys to existing traffic and duplicate the spans Sentry already creates for every v2 `McpServer`.
4. Do not build this on `use` middleware or on extensions from #2820. Middleware only sees inbound requests for one exact method, and an extension advertises a capability on the wire.
5. #2370 is unaffected. `SdkLogger` stays the only path for SDK diagnostics. The OTel package does not ship a logs bridge in its first release.

## Background

### What the SDK does today

- `TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY` and `BAGGAGE_META_KEY` are public constants (`packages/core/src/constants.ts`, from #2270). The SDK passes these `_meta` keys through untouched. `packages/core-internal/test/shared/traceContextMeta.test.ts` pins the passthrough.
- The SEP-2577 deprecation JSDoc on `ServerContext.mcpReq.log`, `sendLoggingMessage` and friends already tells users to "migrate to stderr logging (STDIO servers) or OpenTelemetry". `docs/servers/logging-progress-cancellation.md` says the same. Today there is nothing in the SDK to migrate to.
- There is no span, metric or trace-context code anywhere in `packages/*/src`.

### The semantic conventions

The MCP conventions moved out of `open-telemetry/semantic-conventions` into [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md). I read them at commit `51a0f580` (2026-10-27). The whole document, every MCP attribute and every MCP metric is **Development** status. Names can still change in a minor semconv release, and they have: `mcp.request.id` has been dropped from the registry and `rpc.response.status_code` was added.

The parts this spec relies on:

- **Span name** `{mcp.method.name} {target}`, where target is `gen_ai.tool.name` or `gen_ai.prompt.name`. Plain `{mcp.method.name}` when there is no low-cardinality target. Resource URIs stay out of span names by default.
- **Span kind** `CLIENT` on the side that sends a request or notification, `SERVER` on the side that receives it. This holds in both directions, so a server sending `sampling/createMessage` emits a `CLIENT` span.
- **Attributes:** `mcp.method.name` (required); `error.type`, `rpc.response.status_code`, `gen_ai.tool.name`, `gen_ai.prompt.name`, `jsonrpc.request.id`, `mcp.resource.uri` (conditionally required); `gen_ai.operation.name` (`execute_tool` on tool calls only), `mcp.protocol.version`, `mcp.session.id`, `network.transport`, `network.protocol.name`, `network.protocol.version`, `server.address`, `server.port`, `client.address`, `client.port` (recommended); `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.prompt.variable.<name>` (opt-in, sensitive).
- **Errors:** a JSON-RPC error sets `rpc.response.status_code` and `error.type` to the code as a string, and status `ERROR` with the JSON-RPC message as description. On the receiver, `-32700`, `-32600`, `-32601`, `-32602` and `-32002` are not errors. On the sender, every code is an error. A `CallToolResult` with `isError: true` sets `error.type` to `tool_error`.
- **Propagation:** inject with the configured OTel propagators into `params._meta` of every request and notification, using the unprefixed keys SEP-414 reserves. The receiver uses the extracted context as the parent of its `SERVER` span and links the ambient context (for example the HTTP server span). MCP and HTTP contexts are independent.
- **Metrics:** histograms `mcp.client.operation.duration`, `mcp.server.operation.duration`, `mcp.client.session.duration` and `mcp.server.session.duration`, unit `s`, explicit buckets `[0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]`.
- **Outer GenAI span:** if the instrumentation can reliably tell that an outer `execute_tool` span already covers the tool call, it SHOULD add MCP attributes to that span instead of creating one.

The well-known `mcp.method.name` values stop at the 2025-era methods. `server/discover`, `subscriptions/listen` and the Tasks extension methods are allowed as custom values but have no entries yet.

### The MCP specification

[SEP-414](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/414-request-meta.md) (Final) reserves `traceparent`, `tracestate` and `baggage` in `_meta` with W3C formats. It says nothing about which messages carry them, about server-to-client traffic, or about HTTP headers. [SEP-2028](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2028), which would forward these keys to downstream HTTP headers, is still an open PR. This repo already rejected HTTP header forwarding without protocol support in [#666](https://github.com/modelcontextprotocol/typescript-sdk/pull/666).

### Other official SDKs

| SDK                                                                         | How it ships                                                                                                            | Default                          | What it emits                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python (`src/mcp/shared/_otel.py`, `src/mcp/server/_otel.py`)               | Hard dependency on `opentelemetry-api`                                                                                  | On for every server and client   | `SERVER` spans from an `OpenTelemetryMiddleware` that is first in `Server.middleware`. `CLIENT` spans named `MCP send {method} {target}` from the dispatcher, with a TODO to move them to an outbound middleware. `_meta` inject and extract. No metrics. |
| C# (`src/ModelContextProtocol.Core/Diagnostics.cs`, `McpSessionHandler.cs`) | `System.Diagnostics` `ActivitySource` and `Meter`, both named `Experimental.ModelContextProtocol`. No extra dependency. | Free until a listener subscribes | All four metrics with the semconv buckets, spans in both directions, links to the ambient activity, reuse of an outer `execute_tool ` activity. Skips `notifications/message`.                                                                            |
| Go                                                                          | Nothing built in                                                                                                        | n/a                              | n/a                                                                                                                                                                                                                                                       |

Two things C# does that this spec deliberately does not copy. It records `mcp.resource.uri` as a metric attribute, which the conventions list as opt-in for metrics. It also puts a failed tool's `content` JSON into the span status description, which can leak tool output.

### Third-party instrumentation of this SDK

| Instrumentation                                               | Targets                                                                      | Mechanism                                                                                                                                                    | `_meta` propagation                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Sentry JS 11.1+ (`packages/core/src/integrations/mcp-server`) | v1 `@modelcontextprotocol/sdk` and v2 `@modelcontextprotocol/server`         | Patches `McpServer.connect`, then `transport.onmessage` and `transport.send`, and every registered handler. Auto-wraps every `McpServer` when tracing is on. | No. Uses its own attribute names (`mcp.tool.name`, `mcp.prompt.name`) and records inputs and outputs by default. |
| OpenInference (`@arizeai/openinference-instrumentation-mcp`)  | v1 module paths only (`@modelcontextprotocol/sdk/client/stdio.js` and so on) | Patches transport `send` and `onmessage`                                                                                                                     | Yes, inject and extract. Creates no spans of its own.                                                            |
| OpenLLMetry (`@traceloop/instrumentation-mcp`)                | v1 `sdk/client/index.js`, `sdk/server/index.js`                              | Patches `Client` and `Server`                                                                                                                                | No                                                                                                               |
| Logfire                                                       | Python only                                                                  | n/a                                                                                                                                                          | n/a                                                                                                              |

All of them monkey-patch. That is why they lag the SDK's module layout (only Sentry knows about the v2 packages) and why ESM loaders crash in cases like [#1020](https://github.com/modelcontextprotocol/typescript-sdk/issues/1020). A supported hook removes the need to patch.

## Goals

1. Traces and metrics that follow the MCP semantic conventions, for `Client`, `McpServer` and low-level `Server`, on every transport, in both protocol eras (2025-11-25 and 2026-07-28).
2. Client-to-server and server-to-client trace context through `params._meta`, interoperable with the Python and C# SDKs.
3. Zero cost when unused. No instrumentation configured means no allocation, no extra branch beyond one `undefined` check per message, and byte-identical wire output.
4. Works in Node, Bun, Deno, Cloudflare Workers and browsers.
5. Safe defaults. No arguments, results, prompt variables or tokens recorded unless the user asks.
6. A hook other vendors (Sentry, Arize, Traceloop) can implement instead of patching.

## Non-goals

- Spans for transport work: HTTP requests, SSE streams, reconnects, stdio process lifecycle. HTTP and fetch instrumentations already cover these, and the conventions treat them as separate.
- Writing `traceparent` HTTP headers from MCP `_meta`, or reading MCP context from HTTP headers. That is SEP-2028's job if it lands.
- An OTel logs signal in the first release (see [Logs and #2370](#logs-and-2370)).
- Converting `ctx.mcpReq.log` or `notifications/message` into OTel log records.
- Configuring OTel SDKs, exporters or context managers. That stays the application's job.
- Detecting an outer `execute_tool` span. `@opentelemetry/api` exposes no span name, so the instrumentation cannot do it reliably, and the conventions only ask for it when it can.
- A v1.x backport (see [Rollout](#rollout)).

## Dependency strategy

All four options have to work in Node, Bun, Deno, Workers and browsers. `@opentelemetry/api` itself does: it is plain JavaScript with no dependencies and keeps its global state on `globalThis`.

| Option                                                                                                                                               | For                                                                                                                                                                     | Against                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `@opentelemetry/api` as a regular dependency of `core-internal`, bundled into `client` and `server` (Python's choice)                             | Zero setup. One package to install.                                                                                                                                     | A new runtime dependency in every published package, which `DEPENDENCY_POLICY.md` treats as significant. Semconv is Development, so every rename would ship as a change in `client` and `server`. On-by-default would change the wire for existing users. |
| B. `@opentelemetry/api` as an optional peer of `client` and `server`                                                                                 | No install for users who don't want it                                                                                                                                  | A static import breaks when the peer is missing. A dynamic `import()` makes setup async and confuses bundlers, Workers included.                                                                                                                          |
| C. No dependency. Core accepts the OTel API object (`{ api: otel }`) and implements the conventions against structural copies of the OTel interfaces | No new package                                                                                                                                                          | Core then owns a structural mirror of `Tracer`, `Span`, `Context`, `TextMapPropagator` and `Meter`, plus the whole semconv mapping. Semconv churn still lands in `client` and `server` releases.                                                          |
| D. **Recommended.** A small OTel-free hook in core, and a separate `@modelcontextprotocol/otel` with `@opentelemetry/api` as a peer                  | Core gains one option and a handful of types, and no dependency. The semconv mapping versions on its own line while it is Development. Vendors implement the same hook. | One more package to publish and document.                                                                                                                                                                                                                 |

D matches what the ecosystem has converged on: `@hono/otel` and `@fastify/otel` sit outside their frameworks. The AI SDK is the closest precedent. Its v7 dropped the direct `@opentelemetry/api` dependency from `ai` in favour of a `Telemetry` interface in core, with spans moved into `@ai-sdk/otel` (which depends on `@opentelemetry/api`). Its interface has an `executeTool({ execute })` method that runs work inside the integration's context, which is the same job `OperationScope.run` does below.

The peer range for `@opentelemetry/api` is `^1.9.0`. Histogram bucket advice (`advice.explicitBucketBoundaries`) needs 1.7 or later.

## Public API

### Core: `instrumentation` on `ProtocolOptions`

`ProtocolOptions` (`packages/core-internal/src/shared/protocol.ts:72`) gets one optional field. `ClientOptions`, `ServerOptions` and `McpServerOptions` all extend it, so `Client`, `Server` and `McpServer` accept it with no further change. This differs from #2370, which moved `logger` off `ProtocolOptions` because low-level `Server` emits no diagnostics. Low-level `Server` does send and receive messages, so it should be instrumentable.

```ts
export type ProtocolOptions = {
    // ...existing fields...

    /**
     * Observes every message this instance sends and receives, for tracing and metrics.
     *
     * @experimental The shape may change in a minor release.
     */
    instrumentation?: ProtocolInstrumentation;
};
```

The types, exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server` the same way `SdkLogger` is:

```ts
/** @experimental */
export interface ProtocolInstrumentation {
    /** A request or notification is about to be sent. Write trace context into `operation.carrier`. */
    send?(operation: OutboundOperation): OperationScope | undefined;
    /** A request or notification arrived and is about to be dispatched. */
    receive?(operation: InboundOperation): OperationScope | undefined;
    /** The instance connected to a transport. The returned callback runs once when it closes. */
    connect?(session: SessionStart): ((end: SessionEnd) => void) | undefined;
}

/** @experimental */
export interface OperationBase {
    readonly method: string;
    /** Absent for notifications. */
    readonly id?: RequestId;
    /** The params as they go on (or came off) the wire. Read-only. */
    readonly params?: Readonly<Record<string, unknown>>;
    readonly sessionId?: string;
    readonly protocolVersion?: string;
}

/** @experimental */
export interface OutboundOperation extends OperationBase {
    /** Keys written here are copied into `params._meta`. Prefilled with caller-supplied `traceparent`, `tracestate` and `baggage`. */
    readonly carrier: Record<string, string>;
}

/** @experimental */
export interface InboundOperation extends OperationBase {
    /** The request or notification `_meta`, including `traceparent`, `tracestate` and `baggage` when present. */
    readonly meta?: Readonly<Record<string, unknown>>;
    /** Whether a handler (or fallback handler) is registered for `method`. */
    readonly handled: boolean;
    /** The HTTP request, when the transport supplied one. */
    readonly httpRequest?: Request;
}

/** @experimental */
export interface OperationScope {
    /** Runs the operation's work in the instrumentation's context: the transport send, or the handler. Must call `fn` once. */
    run<T>(fn: () => T): T;
    /** Called exactly once when the operation settles. */
    end(outcome: OperationOutcome): void;
}

/** @experimental */
export type OperationOutcome = { type: 'result'; result: Result } | { type: 'error'; error: { code: number; message: string }; cause?: unknown } | { type: 'delivered' } | { type: 'timeout' } | { type: 'cancelled' } | { type: 'closed' } | { type: 'failed'; error: unknown };

/** @experimental */
export interface SessionStart {
    readonly role: 'client' | 'server';
}

/** @experimental */
export interface SessionEnd {
    readonly sessionId?: string;
    readonly protocolVersion?: string;
    readonly error?: unknown;
}
```

Rules `Protocol` follows when calling it:

- It calls `send` or `receive` once per JSON-RPC request or notification, never for responses. Responses settle the scope of the request they answer.
- It calls `end` exactly once per scope, on every exit path. A `settled` flag guards it, the same way `cleanupMessageId` guards cleanup today.
- It never mutates caller-owned objects. The carrier is merged into a copy of `params._meta`.
- A throwing instrumentation method never fails the operation. `Protocol` catches the error, reports it through `onerror`, and carries on without that scope. If `run` throws before calling `fn`, `Protocol` calls `fn` itself. This is the same guarantee #2370's `guardLogger` gives for loggers.
- When `instrumentation` is undefined, each hook point is one property read and an `undefined` check.

The hook is intentionally not OTel-shaped. Here is a non-OTel use, an audit log:

```ts
const audit: ProtocolInstrumentation = {
    receive(operation) {
        const started = performance.now();
        return {
            run: fn => fn(),
            end: outcome => auditLog.write({ method: operation.method, outcome: outcome.type, ms: performance.now() - started })
        };
    }
};
```

### `@modelcontextprotocol/otel`

```ts
export interface OpenTelemetryOptions {
    /** @default the global tracer provider */
    tracerProvider?: TracerProvider;
    /** @default the global meter provider */
    meterProvider?: MeterProvider;
    /** @default the global propagator (`propagation` from `@opentelemetry/api`) */
    propagator?: TextMapPropagator;
    /** Record tool arguments and results and prompt arguments. Off by default. */
    captureContent?: boolean;
}

export function openTelemetry(options?: OpenTelemetryOptions): ProtocolInstrumentation;
```

`openTelemetry()` creates its tracer and instruments once, with instrumentation scope name `@modelcontextprotocol/otel` and the package version. Create it once and share it across instances. That matters for `createMcpHandler`, whose factory builds a new `McpServer` for every HTTP request.

There is no environment-variable configuration. Workers and browsers have no `process.env`, and `captureContent` is a privacy switch that belongs in code.

Client:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { openTelemetry } from '@modelcontextprotocol/otel';

const client = new Client({ name: 'agent', version: '1.0.0' }, { instrumentation: openTelemetry() });
await client.connect(new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp')));

// Emits "tools/call get-weather" (CLIENT), a child of the span active here,
// and puts its traceparent in params._meta.
await client.callTool({ name: 'get-weather', arguments: { city: 'Lisbon' } });
```

Server over HTTP:

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { openTelemetry } from '@modelcontextprotocol/otel';
import * as z from 'zod/v4';

const instrumentation = openTelemetry();

export const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation });
    server.registerTool('get-weather', { inputSchema: z.object({ city: z.string() }) }, async ({ city }) => ({
        // Spans created here are children of "tools/call get-weather" (SERVER).
        content: [{ type: 'text', text: await forecast(city) }]
    }));
    return server;
});
```

Server over stdio uses the same option on the instance the `serveStdio` factory returns. `invoke` and the legacy stateless fallback in `createMcpHandler` also connect the factory's instance, so all entry points pick up the option without changes to `createMcpHandler.ts`, `serveStdio.ts` or `invoke.ts`.

## Where the hooks go

| Hook                  | Location (`packages/core-internal/src/shared/protocol.ts` unless noted)                                   | What happens                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound request      | `_requestWithSchemaViaCodec` (L1379), after `outbound` is built and before `this._transport.send` (L1588) | `send()`. Merge the carrier into `outbound.params._meta`. Wrap `transport.send` in `scope.run` so fetch instrumentation parents the HTTP span under the MCP span.                                                                                                                                                                                                                                                            |
| Request settles       | Response handler (L1509), `cancel()` (L1465), the `.catch` on send, and `_onclose` (L836)                 | `end()` with `result` after schema validation, `error` for a JSON-RPC error, `failed` for `InvalidResult` or a send failure, `timeout` when `timeoutHandler` fires, `cancelled` when `options.signal` aborts, `closed` when the connection drops. `cancel()` already has separate call sites for timeout and abort, so the outcome is exact even though both reject with `RequestTimeout` today.                             |
| Multi-round-trip legs | `flow.retry` and `Client._resolveNonCompleteResult` (`packages/client/src/client/client.ts:743`)          | Each retry leg goes through `_requestWithSchemaViaCodec`, so each leg gets its own scope. The client runs the embedded elicitation and sampling handlers inside the scope of the leg that returned `input_required`, so user spans in those handlers nest under that leg.                                                                                                                                                    |
| Outbound notification | `_notificationViaCodec` (L1620)                                                                           | `send()`, merge the carrier, `scope.run` around `transport.send`, `end()` with `delivered` or `failed`. A debounced notification starts its scope inside the microtask (L1659) that writes it, so coalesced notifications produce one scope.                                                                                                                                                                                 |
| Inbound request       | Top of `_onrequest` (L938)                                                                                | `receive()` before the era, method and envelope checks, so rejections the protocol answers itself still get a scope. `sendErrorResponse` ends it with `error`. The handler call (L1115) runs inside `scope.run`, which covers #2820's middleware too. After the result is encoded, `end()` with `result`, or `error` with the thrown value as `cause`. A request aborted by `notifications/cancelled` ends with `cancelled`. |
| Inbound notification  | `_onnotification` (L877)                                                                                  | `receive()`, `scope.run` around the handler, `end()` with `delivered`, or `failed` if the handler throws.                                                                                                                                                                                                                                                                                                                    |
| Session               | `connect` (L794) and `_onclose` (L836)                                                                    | `connect()` when the transport starts. The returned callback runs from `_onclose` with the session id and negotiated version as they were at close.                                                                                                                                                                                                                                                                          |

`McpServer`, `Client` and the transports need no telemetry code. The tool or prompt name and the resource URI come from `params`. Negotiated version comes from `_negotiatedProtocolVersion`, session id from `transport.sessionId`, and the HTTP request from `MessageExtraInfo.request`.

Rejections `createMcpHandler` produces before any instance exists (header ladder, unsupported version, body too large, 405 on GET) never reach `Protocol`. They produce no MCP span. The HTTP server span from the user's HTTP instrumentation already covers them.

## Spans

### What gets a span

| Operation                                                                                                                                                                       | Sender                 | Receiver               | Notes                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any request (`initialize`, `server/discover`, `ping`, `tools/*`, `resources/*`, `prompts/*`, `completion/complete`, `logging/setLevel`, `subscriptions/listen`, custom methods) | `CLIENT`               | `SERVER`               | One span per JSON-RPC request on the wire. Version probing during `Client.connect` (`server/discover`, then a fallback `initialize`) yields one span per probe, which is what happened on the wire. |
| 2025-era server-to-client requests (`sampling/createMessage`, `elicitation/create`, `roots/list`)                                                                               | `CLIENT` on the server | `SERVER` on the client | Sent through `ctx.mcpReq.send`, so the `CLIENT` span is a child of the handler's `SERVER` span.                                                                                                     |
| 2026-era input requests embedded in `input_required` results                                                                                                                    | none                   | none                   | Not wire messages. Each retry leg is a normal `CLIENT`/`SERVER` pair.                                                                                                                               |
| Notifications (`notifications/initialized`, `progress`, `cancelled`, `*/list_changed`, `resources/updated`, custom)                                                             | `CLIENT`               | `SERVER`               | The span ends when the transport accepts the write (sender) or the handler returns (receiver).                                                                                                      |
| `notifications/message`                                                                                                                                                         | none                   | none                   | The hook still sees it. The OTel package skips it, following C#. It is deprecated by SEP-2577 and usually carries log traffic users want to see as logs, not spans.                                 |
| Responses                                                                                                                                                                       | none                   | none                   | A response settles its request's span.                                                                                                                                                              |

### Name and kind

- Name: `{method} {target}` for `tools/call` (target `params.name`) and `prompts/get` (target `params.name`), else `{method}`. Never the resource URI.
- Receiver-side unknown methods: when `handled` is false, the name and `mcp.method.name` are `_OTHER`, borrowing the HTTP conventions' rule for unknown methods. A peer can otherwise send any string as a method name and blow up cardinality.
- Receiver-side unknown tools and prompts: `McpServer` answers an unknown or disabled tool or prompt with `-32602`. When a `tools/call` or `prompts/get` span ends with `-32602`, the OTel package renames it to the bare method with `updateName` and drops `gen_ai.tool.name` or `gen_ai.prompt.name` from metric attributes. A rejected name stays on the span as an attribute only. That also covers a prompt whose arguments fail validation, which costs us the prompt name on those metrics. I think that trade is fine.
- `CLIENT` for outbound, `SERVER` for inbound, whatever the instance's role.

### Attributes

| Attribute                                                                                | Set when                                                                                            | Source                                                         |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `mcp.method.name`                                                                        | Always                                                                                              | `operation.method`, or `_OTHER` as above                       |
| `jsonrpc.request.id`                                                                     | Requests                                                                                            | `String(operation.id)`                                         |
| `mcp.protocol.version`                                                                   | Once negotiated                                                                                     | `operation.protocolVersion`                                    |
| `mcp.session.id`                                                                         | When the transport has a session id (legacy stateful Streamable HTTP)                               | `operation.sessionId`. The 2026-07-28 era and stdio have none. |
| `gen_ai.operation.name`                                                                  | `tools/call` only                                                                                   | `execute_tool`                                                 |
| `gen_ai.tool.name`                                                                       | `tools/call`                                                                                        | `params.name`                                                  |
| `gen_ai.prompt.name`                                                                     | `prompts/get`                                                                                       | `params.name`                                                  |
| `mcp.resource.uri`                                                                       | `resources/read`, `resources/subscribe`, `resources/unsubscribe`, `notifications/resources/updated` | `params.uri`. Spans only.                                      |
| `rpc.response.status_code`                                                               | A JSON-RPC error response                                                                           | `String(error.code)`                                           |
| `error.type`                                                                             | Failure (see below)                                                                                 |                                                                |
| `network.transport`, `network.protocol.name`                                             | Receiver, when `httpRequest` is present                                                             | `tcp` and `http`. Left unset otherwise; see open question 6.   |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.prompt.variable.<name>` | Only with `captureContent: true`                                                                    | See [Privacy](#privacy)                                        |

`server.address`, `server.port`, `client.address`, `client.port` and `network.protocol.version` are left unset. `Protocol` can't see the URL or socket, and fetch instrumentation records them on the HTTP span anyway.

The OTel package computes attributes only when `span.isRecording()` is true. A sampled-out or no-op span costs one `startSpan` and one `end`.

### Status and `error.type`

| Outcome                                                                          | `error.type`                                                            | `rpc.response.status_code` | Status                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `result`, `tools/call` with `isError: true`                                      | `tool_error`                                                            | unset                      | `ERROR`, no description (the content stays out of telemetry)                                                                      |
| `result`, anything else (including `input_required`)                             | unset                                                                   | unset                      | `UNSET`                                                                                                                           |
| `error`, sender side                                                             | code as string                                                          | code as string             | `ERROR`, description = JSON-RPC message                                                                                           |
| `error`, receiver side, code in `-32700`, `-32600`, `-32601`, `-32602`, `-32002` | unset                                                                   | code as string             | `UNSET`                                                                                                                           |
| `error`, receiver side, any other code                                           | code as string                                                          | code as string             | `ERROR`, description = JSON-RPC message. If `cause` is an exception that is not a `ProtocolError`, also `recordException(cause)`. |
| `timeout`                                                                        | `timeout`                                                               | unset                      | `ERROR`                                                                                                                           |
| `cancelled`                                                                      | `cancelled`                                                             | unset                      | `ERROR` (open question 4)                                                                                                         |
| `closed`                                                                         | `connection_closed`                                                     | unset                      | `ERROR`                                                                                                                           |
| `failed` with an `SdkError`                                                      | its `code` (`SEND_FAILED`, `INVALID_RESULT`, ...)                       | unset                      | `ERROR`                                                                                                                           |
| `failed`, anything else                                                          | `error.name` when it is a standard `Error` subclass name, else `_OTHER` | unset                      | `ERROR`                                                                                                                           |

The package docs list every `error.type` value it can emit, as the conventions ask.

### Feature notes

- **`initialize` and `server/discover`.** Ordinary request spans. `mcp.protocol.version` is unset on the first `initialize` because nothing is negotiated yet. The conventions' examples set it from the request. Doing the same means reading `params.protocolVersion`, which is cheap, so the package does it for these two methods.
- **Progress.** `notifications/progress` sent from a handler inherits the handler's `SERVER` context and injects it, so on the requester the progress span is a child of the remote handler span. That is accurate but chatty on long jobs. Progress callbacks registered with `onprogress` run inside that inbound span.
- **Cancellation.** The `notifications/cancelled` the SDK sends on abort gets its own `CLIENT` span. The 2026-07-28 Streamable HTTP path cancels by aborting the request stream and sends nothing, so there is no notification span there, just `cancelled` on the request. `initialize` is never cancelled on the wire, so it only ends `cancelled` locally.
- **Tasks extension (SEP-2663, #2782).** `tools/call` answered with `resultType: "task"` ends its span when that response is sent. `tasks/get`, `tasks/result` and `tasks/cancel` are ordinary request spans. The background work behind a task outlives the `tools/call` span. The Tasks extension should capture the active context when it creates the task and start the work's spans as children of it. That belongs in the Tasks PR, not here. There is no task id attribute in the conventions, and the package will not invent one (open question 10).
- **`subscriptions/listen`.** The span covers the whole subscription, which can last hours and lands every observation in the top bucket of `mcp.client.operation.duration` (open question 11).
- **Custom methods.** Spans like any other method. The method name is recorded when a handler is registered for it.
- **Middleware (#2820).** `use` middleware runs inside `scope.run`, so spans it creates are children of the `SERVER` span, and an answer it returns without calling `next` still ends the span with that result.

### Transport-level spans

The SDK creates protocol spans only. On Streamable HTTP the expected shape matches the conventions' example. The client's `transport.send` runs inside the `CLIENT` span's context, so fetch or undici instrumentation makes the `POST` a child of the MCP span. On the server, the HTTP server span is ambient when the message arrives, and the MCP `SERVER` span links to it. [#1231](https://github.com/modelcontextprotocol/typescript-sdk/issues/1231) (undici marks successful POSTs as aborted on `close()`) makes those HTTP spans look wrong today. It is a separate bug, but it will be more visible once MCP spans sit on top.

## Context propagation

### Outbound

1. `Protocol` prefills `operation.carrier` with any `traceparent`, `tracestate` and `baggage` strings the caller already put in `params._meta`.
2. The OTel package extracts the carrier. If it holds a valid context, that becomes the `CLIENT` span's parent. Otherwise the active context is the parent.
3. It starts the span, then injects the span's context with the configured propagator into the carrier, replacing what was there.
4. `Protocol` writes the carrier's keys into a copy of `params._meta`.

A caller who set `traceparent` by hand keeps the same trace and gets a more precise parent on the server, the SDK's `CLIENT` span instead of their own. With no instrumentation configured, nothing changes and the passthrough test keeps passing as it does today.

Both requests and notifications get injected, as the conventions say. Server-to-client traffic does the same thing in reverse.

### Inbound

1. The OTel package extracts `operation.meta`. A missing, malformed or invalid `traceparent` yields no context, and the request is served normally. The SDK never rejects a message over its trace context.
2. With a valid extracted context, it is the `SERVER` span's parent and the active span at arrival (the HTTP server span, say) becomes a link.
3. Without one, the active context is the parent and there is no link. That matches Python and keeps the MCP span inside the HTTP trace instead of starting an orphan.
4. `scope.run` makes the `SERVER` span active for the handler and everything it awaits.

### HTTP headers

The SDK neither writes nor reads `traceparent` HTTP headers for MCP context. On the client, fetch instrumentation adds the HTTP-level header for the HTTP span, which is already a child of the MCP span. On the server, HTTP instrumentation continues that header's trace for the HTTP span, and the MCP span follows rule 2 or 3 above. A peer that sends only the HTTP header still ends up in one trace through rule 3. Forwarding `_meta` to downstream HTTP calls is SEP-2028's business.

### Peers without support

`_meta` is open, SEP-414 reserves these keys, and every conforming peer ignores keys it doesn't know. Nothing needs negotiating. A peer that sends no trace context gets rule 3. The SDK neither advertises nor requires anything.

### Context managers by runtime

Parent extraction passes contexts explicitly, so it works everywhere. Making the handler's span active for user code needs a context manager registered by the application:

| Runtime            | Context manager                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Node, Bun, Deno    | `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`                                        |
| Cloudflare Workers | An `AsyncLocalStorage`-based manager, with `nodejs_compat`                                                         |
| Browsers           | `ZoneContextManager`, or none. Without one, MCP spans are still correct but user spans inside handlers won't nest. |

`scope.run` wraps the call that creates the handler's promise chain (`Promise.resolve().then(() => handler(...))`). `AsyncLocalStorage` carries the context into every continuation of that chain, including the response `send`.

## Metrics

| Instrument                      | Type      | Unit | Recorded                                           |
| ------------------------------- | --------- | ---- | -------------------------------------------------- |
| `mcp.client.operation.duration` | Histogram | `s`  | When an outbound scope ends                        |
| `mcp.server.operation.duration` | Histogram | `s`  | When an inbound scope ends                         |
| `mcp.client.session.duration`   | Histogram | `s`  | When a `Client` connection closes                  |
| `mcp.server.session.duration`   | Histogram | `s`  | When a server connection with a `sessionId` closes |

All four pass `advice: { explicitBucketBoundaries: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300] }`. Durations come from `performance.now()`. On Workers that clock only advances across I/O, so durations there measure I/O time. The docs will say so.

Operation metric attributes come from a fixed allowlist: `mcp.method.name`, `error.type`, `rpc.response.status_code`, `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.prompt.name`, `mcp.protocol.version`, and `network.transport` and `network.protocol.name` when known. Session metric attributes are `error.type`, `mcp.protocol.version` and the network pair.

Never on metrics: `mcp.session.id`, `jsonrpc.request.id`, `mcp.resource.uri` (opt-in in the conventions, not offered in this version), and content attributes.

Cardinality on the receiver is bounded by what the server has registered. Unknown methods become `_OTHER`, rejected tool and prompt names are dropped, `error.type` comes from the documented list plus JSON-RPC codes, and protocol versions are a short list. The OTel metrics SDK's per-instrument cardinality limit (2000 by default) is the backstop. On the sender, tool and prompt names come from the server's listing, which the client chose to connect to.

Session duration is only recorded where a session means something. A `Client` connection always counts, from `connect` to close. On the server, `createMcpHandler` builds one instance per HTTP request on the 2026-07-28 era and the stateless legacy path. Recording each of those as a session would fill the histogram with millisecond "sessions". So the server metric only records when the transport had a `sessionId`, which means legacy stateful Streamable HTTP. A stdio server is a real session without a session id, and this rule misses it (open question 7).

## Logs and #2370

#2370 adds `SdkLogger` (optional `debug` and `warn`) on `Client`, `McpServer`, `createMcpHandler` and `OAuthClientProvider`, wrapped by `guardLogger` so a throwing logger never fails an SDK call. This spec leaves it alone:

- **#2370 lands as it is.** Neither change depends on the other, and they can merge in either order. `ProtocolOptions` gains `instrumentation` while `logger` stays on `ClientOptions` and `McpServerOptions`.
- **`SdkLogger` stays the path for SDK diagnostics.** The instrumentation hook does not carry diagnostics. Some diagnostics come from the OAuth flow, which runs in `auth()` and the auth providers, outside any `Protocol`. #2370 put the logger on `OAuthClientProvider` for exactly that reason, and a protocol hook can't reach that code.
- **No logs bridge in the first release.** `@opentelemetry/api-logs` is still 0.x. Users who want SDK diagnostics as OTel log records write a small adapter, which the docs page will show:

```ts
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { SdkLogger } from '@modelcontextprotocol/server';

const otelLogger = logs.getLogger('@modelcontextprotocol/server');
const logger: SdkLogger = {
    debug: (...args) => otelLogger.emit({ severityNumber: SeverityNumber.DEBUG, body: args.map(String).join(' ') }),
    warn: (...args) => otelLogger.emit({ severityNumber: SeverityNumber.WARN, body: args.map(String).join(' ') })
};
```

- **Later, if asked for:** `@modelcontextprotocol/otel` can export `openTelemetryLogger(): SdkLogger`. That is additive and changes nothing in #2370's API.
- **MCP protocol logging** (`notifications/message`) is a separate thing. The SDK does not turn it into OTel logs. The deprecated-logging docs will link the new OpenTelemetry page as the migration target SEP-2577 names.

On KKonstantinov's review comment about RFC 5424 levels: OTel severity numbers cover that mapping if a bridge ever ships (`debug` is `DEBUG` 5, `warn` is `WARN` 13). It doesn't affect this spec.

## Privacy

Never recorded by default:

- Tool arguments and results, prompt arguments, completion values
- Resource contents, sampling messages, elicitation requests and responses
- The `content` of a failed tool result (C# records it, this does not)
- JSON-RPC error `data`
- HTTP headers, `authInfo`, access tokens, OAuth state
- `requestState` and `inputResponses` (2026-07-28 multi-round-trip material)
- Baggage values as attributes

Recorded by default, and worth knowing about:

- **`mcp.resource.uri`** on spans. The conventions make it conditionally required, but URIs can carry user names, paths or database names. Open question 9 asks whether to keep the default.
- **`mcp.session.id`.** The spec says session ids must be unguessable and must not be used for authentication, so recording one doesn't grant access. It is still an identifier that lands in telemetry storage.
- **JSON-RPC error messages** as status descriptions. The message is already on the wire to the peer. On the receiver it can echo client input, such as the tool name in "Tool X not found".
- **Exception message and stack** for handler failures that are not `ProtocolError`. These are developer-written strings and stay in the operator's backend.
- **Baggage propagation.** The default global propagator usually includes W3C Baggage, which sends baggage entries to the MCP server, possibly a third party. `openTelemetry({ propagator: new W3CTraceContextPropagator() })` sends trace context only (open question 8).

With `captureContent: true`, the package adds:

- `gen_ai.tool.call.arguments`: `params.arguments` as a JSON string. `@opentelemetry/api` span attributes can't hold structured values, and the conventions allow a JSON string on spans in that case.
- `gen_ai.tool.call.result`: `structuredContent` when present, otherwise `content`, as a JSON string, on success only.
- `gen_ai.prompt.variable.<name>` for each `prompts/get` argument.

Serialization happens only when the span is recording. Length limits come from the OTel SDK's `attributeValueLengthLimit`.

## Coexistence with other instrumentations

- **Sentry.** Sentry 11.1+ auto-wraps every v2 `McpServer` by patching `connect` and the transport. With `openTelemetry()` also on, the server gets two spans per message, and they won't nest, because ours parents to the client's `_meta` context. The docs should tell users to pick one. The real fix is Sentry implementing `ProtocolInstrumentation` instead of patching, and the experimental period is the time to ask them (open question 12).
- **OpenInference, OpenLLMetry.** They patch v1 module paths only, so they don't touch v2 packages. Someone mixing a v1 client with OpenInference and a v2 server with this package gets working propagation, because both use the same `_meta` keys.
- **Python and C# peers.** Same keys, same span names (except Python's `MCP send` client prefix) and same attributes, so cross-language traces join.

## Why not #2820's middleware or extensions

#2820 adds `Protocol.use(method, middleware)` and extensions shaped `{ id, setup(ctx) }`. I checked both against what telemetry needs.

| Need                                                                                   | `use` middleware                                                | Extension                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Every inbound request                                                                  | No. Method names are exact and there is no wildcard, by design. | Only through `ctx.use`, same limit                                     |
| Inbound notifications                                                                  | No                                                              | No                                                                     |
| Outbound requests and notifications, `_meta` injection                                 | No                                                              | No                                                                     |
| Errors the protocol answers before dispatch (`-32601`, era mismatch, missing envelope) | No. Middleware runs after those checks.                         | No                                                                     |
| Timeouts, local cancel, connection close on the sender                                 | No                                                              | No                                                                     |
| Leaves the wire alone                                                                  | Yes                                                             | No. Every extension is advertised under `capabilities.extensions[id]`. |
| Status                                                                                 | `@experimental`                                                 | `@experimental`                                                        |

Python built its server spans on middleware because its server middleware already sees every message, and it still had to hardcode client spans in the dispatcher with a TODO to move them. Telemetry is not a protocol extension, and it shouldn't show up in capabilities. So the hook is separate. It composes with middleware: the scope wraps the resolved handler, middleware included. If `use` later gets a wildcard and an outbound side, moving the OTel package onto it is an internal change to the package that users never see.

## Testing

Unit tests for the hook in `packages/core-internal/test/shared/instrumentation.test.ts`, using a fake `ProtocolInstrumentation` over `InMemoryTransport.createLinkedPair()`:

- `end` runs exactly once on every exit path: result, JSON-RPC error, handler throw, timeout, abort, abort before send, connection close, send failure, `InvalidResult`, era mismatch, method not found, missing envelope, `notifications/cancelled` on an in-flight handler, debounced notification.
- The carrier lands in `_meta` without mutating the caller's params. Caller-supplied trace keys are prefilled.
- A throwing `send`, `receive`, `run`, `end` or `connect` never changes the operation's result, and reaches `onerror`.
- With no instrumentation, outbound messages are byte-identical to today. Extend `traceContextMeta.test.ts` with this.

The OTel package tests use `BasicTracerProvider` with `InMemorySpanExporter`, `MeterProvider` with an in-memory `MetricReader`, and `AsyncLocalStorageContextManager`:

- Table-driven checks of name, kind, parent, links, attributes and status for every row in the span and status tables, on both eras.
- Client and server in one process: `CLIENT` to `SERVER` parenting through `_meta`, and a user span inside a tool handler nested under the `SERVER` span.
- A 2025-era `elicitation/create` from inside a tool: the server's `CLIENT` span is a child of its `SERVER` span, and the client's `SERVER` span is a child of that.
- A 2026-era `input_required` round trip: two `tools/call` legs, embedded handler spans under the first leg.
- Privacy: no argument, result or tool-error content without `captureContent`.
- Cardinality: an unknown method and an unknown tool name appear in neither span names nor metric attributes.
- Metrics: bucket advice, attribute allowlist, no session metric for per-request instances.
- Optional CI step: run OTel Weaver's `registry live-check` against the emitted telemetry, pinned to a semconv-genai commit.

End-to-end and runtime tests:

- New entries in `test/e2e/requirements.ts`, for example `observability:trace-context:client-to-server`, `observability:trace-context:server-to-client` and `observability:no-wire-change-when-disabled`, with scenarios across the stdio, Streamable HTTP and in-memory cells.
- `createMcpHandler` behind an instrumented HTTP server: the MCP `SERVER` span links to the HTTP server span.
- The existing runtime suites (`test/integration/test/server/bun.test.ts`, `deno.test.ts`, `cloudflareWorkers.test.ts`) import the package and serve one traced call.
- Conformance: the MCP conformance suite has no SEP-414 scenario today. Contributing one belongs upstream (open question 13).

## Docs

- A new how-to page, `docs/servers/opentelemetry.md` or `docs/advanced/opentelemetry.md`, written to `docs/_meta/CONVENTIONS.md`. It covers install, client and server setup, what spans and metrics show up (quoting real output from a companion example), propagation, `captureContent`, the context-manager table, the Workers clock caveat, and using it with Sentry.
- The package README, including the full `error.type` list.
- `docs/servers/logging-progress-cancellation.md`: point "use OpenTelemetry instead" at the new page, and add the `SdkLogger` adapter example once #2370 is merged.
- `docs/clients/middleware.md`: one line noting that fetch middleware runs inside the MCP `CLIENT` span's context.
- A companion example under `examples/` (stdio client and server, console exporter) that produces the output the docs page quotes.

## Rollout

Stacked PRs that can each land alone:

1. **Hook in core.** `instrumentation` on `ProtocolOptions`, the types, the call sites, and unit tests. Changeset: minor for `core-internal`, `client` and `server`, flagged `@experimental`. No new dependency.
2. **`@modelcontextprotocol/otel` with traces and propagation.** New package at `packages/otel/`, independently versioned like the framework integrations, peer dependency `@opentelemetry/api ^1.9.0`.
3. **Metrics.**
4. **`captureContent`.**
5. **Docs page and example.**
6. **E2E requirements and runtime smoke tests.** Can fold into 2 to 4 as they land.

Before PR 1, maintainers sign off on #1264 per the discuss-before-you-code rule in `CONTRIBUTING.md`. That is what this document is for.

Semver:

- The hook is `@experimental`, so its shape can change in a minor release, matching `use`, extensions and `acceptResultType` in #2820. It drops the tag once a second implementation (Sentry or another vendor) has used it.
- The OTel package starts at `0.x` while the MCP conventions are Development. Semconv renames ship as minors in `0.x` with a changeset naming each renamed attribute. When the conventions go stable, the package goes to `1.0` and follows them. If GenAI semconv adopts an `OTEL_SEMCONV_STABILITY_OPT_IN` transition for MCP, the package follows it then.
- Nothing is breaking. Without the option, behaviour and wire output are unchanged.

v1.x backport: no. `CONTRIBUTING.md` limits `v1.x` to bug fixes, and this is a feature. v1 users already have OpenInference, OpenLLMetry and Sentry, all of which target v1 module paths. If maintainers want v1 coverage later, the package's semconv mapping can sit behind a `Transport` decorator, since v1 and v2 share the transport shape. That stays out of scope here.

## Open questions

1. **New package.** Is a new published `@modelcontextprotocol/otel` acceptable, on its own `0.x` line? The alternative is option A, a direct `@opentelemetry/api` dependency in `client` and `server` (Python's approach).
2. **Opt-in.** Python traces every server by default. This spec is opt-in for wire-compatibility and Sentry reasons. Should the SDK instead turn on when a global tracer provider is registered?
3. **Where the hook lives.** `ProtocolOptions`, which includes low-level `Server`, or only `ClientOptions` and `McpServerOptions`? A single `instrumentation`, or an array so the OTel package and a vendor hook can both run?
4. **Cancelled requests.** Should a caller's abort set status `ERROR`, or record `error.type: cancelled` with status `UNSET`? The conventions don't say.
5. **Where the hook types come from.** The OTel package has to name `ProtocolInstrumentation` without depending on `client` or `server` (it serves both). The options are a structural copy plus a compile-time assignability test, or exporting the types from `@modelcontextprotocol/core`, which is schemas and constants today.
6. **`network.transport` on stdio and on the client.** `Protocol` can't tell stdio from in-memory, or HTTP on the client side. Add an optional self-describing field to `Transport`, or leave these recommended attributes unset?
7. **Server session duration.** Only legacy stateful HTTP qualifies under the current rule. Should `serveStdio` and plain `connect(stdioTransport)` count as sessions, and how should `Protocol` know?
8. **Baggage.** Should the default propagator send W3C Baggage to MCP servers, which may be third parties, or should the default be trace context only?
9. **`mcp.resource.uri` on spans.** Keep it on by default because the conventions make it conditionally required, or make it opt-in for privacy?
10. **Semconv gaps.** `server/discover`, `subscriptions/listen`, the Tasks methods and a task id attribute have no conventions yet. Who takes these to `semantic-conventions-genai`?
11. **`subscriptions/listen` durations.** Leave long-lived subscriptions in `mcp.*.operation.duration` per the conventions, or exclude them?
12. **Vendors.** Should Sentry and Arize be invited to implement the hook during the experimental period, before it is stabilized?
13. **Conformance.** Should someone propose a SEP-414 propagation scenario to the MCP conformance suite, so all SDKs are tested the same way?
14. **Remote parents on public servers.** Should there be an option to start a new trace and only link the client's context, for servers that don't trust callers' trace ids? The conventions say to use the remote parent by default.
