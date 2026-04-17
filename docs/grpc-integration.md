# gRPC Integration via `Dispatcher.dispatchRaw`

Status: experimental. The `dispatchRaw` entry point lets a non-JSON-RPC driver (gRPC, REST, protobuf) call MCP handlers without constructing JSON-RPC envelopes.

## The seam

`McpServer extends Dispatcher`, so any server has:

```ts
mcpServer.dispatchRaw(method: string, params: unknown, env?: DispatchEnv): AsyncIterable<RawDispatchOutput>

type RawDispatchOutput =
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'result'; result: Result }
  | { kind: 'error'; code: number; message: string; data?: unknown };
```

No `{jsonrpc: '2.0', id}` wrapping in or out. Handlers registered via `registerTool`/`setRequestHandler` work unchanged — `dispatchRaw` synthesizes the envelope internally.

## gRPC service binding (sketch)

Given a `.proto` with per-method RPCs (per SEP-1319's named param/result types):

```proto
service Mcp {
  rpc CallTool(CallToolRequestParams) returns (stream CallToolStreamItem);
  rpc ListTools(ListToolsRequestParams) returns (ListToolsResult);
  // ...
}
```

The adapter is one function per method:

```ts
import * as grpc from '@grpc/grpc-js';
import { McpServer } from '@modelcontextprotocol/server';

export function bindMcpToGrpc(mcpServer: McpServer): grpc.UntypedServiceImplementation {
  return {
    async CallTool(call: grpc.ServerWritableStream<CallToolRequestParams, CallToolStreamItem>) {
      const env = { authInfo: extractAuth(call.metadata) };
      for await (const out of mcpServer.dispatchRaw('tools/call', protoToObj(call.request), env)) {
        if (out.kind === 'notification') call.write({ notification: objToProto(out) });
        else if (out.kind === 'result') call.write({ result: objToProto(out.result) });
        else call.destroy(new grpc.StatusBuilder().withCode(grpcCodeFor(out.code)).withDetails(out.message).build());
      }
      call.end();
    },
    async ListTools(call, callback) {
      for await (const out of mcpServer.dispatchRaw('tools/list', protoToObj(call.request))) {
        if (out.kind === 'result') return callback(null, objToProto(out.result));
        if (out.kind === 'error') return callback({ code: grpcCodeFor(out.code), details: out.message });
      }
    },
    // ... one binding per method
  };
}
```

`protoToObj`/`objToProto` are mechanical (protobuf message ↔ plain object). The `.proto` itself can be generated from `spec.types.ts` since SEP-1319 gives every params/result a named top-level type.

## Server→client (elicitation/sampling)

gRPC unary has no back-channel. Two options:

1. **MRTR (recommended):** handler returns `IncompleteResult{InputRequests}`; `dispatchRaw` yields it as the result; the gRPC client re-calls with `inputResponses`. This is the SEP-2322 model and works without bidi streaming.
2. **Bidi stream:** make `tools/call` a bidi RPC; the server writes elicitation requests to the stream, client writes responses. Pass `env.send` that writes to the stream and awaits a matching reply.

`dispatchRaw` supports both: with no `env.send`, `ctx.mcpReq.elicitInput()` throws (handler must use MRTR-native form); with `env.send` provided, it works inline.

## What's not in the SDK

- The `.proto` file (separate artifact, ideally generated)
- The `@modelcontextprotocol/grpc` adapter package (the binding above)
- protobuf↔object conversion helpers
