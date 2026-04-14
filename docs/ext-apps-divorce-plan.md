# ext-apps SDK Divorce Plan

This document outlines how `@modelcontextprotocol/ext-apps` can remove its dependency on
`@modelcontextprotocol/sdk` (v1) without adopting the breaking V2 SDK, by vendoring only
what it actually needs.

## Current State

ext-apps depends on `@modelcontextprotocol/sdk@^1.29.0` for:

| Category | Count | Examples |
|----------|-------|----------|
| Pure TypeScript types | ~46 | `CallToolRequest`, `Tool`, `Implementation`, `JSONRPCMessage` |
| Zod schemas (handler routing) | 11 | `CallToolRequestSchema` u2192 `setRequestHandler(schema, handler)` |
| Zod schemas (result validation) | 7 | `CallToolResultSchema` u2192 `request(req, schema)` |
| Zod schemas (composition) | 7 | `ToolSchema`, `ContentBlockSchema` u2192 `generated/schema.ts` |
| Zod schema (wire validation) | 1 | `JSONRPCMessageSchema.safeParse()` in PostMessageTransport |
| Runtime classes | 3 | `Protocol` (extended), `Client` (instantiated), `Transport` (interface) |
| Server helpers (examples+docs only) | 5 | `McpServer`, `StdioServerTransport`, etc. |

---

## Sources of Truth

### For types: MCP Specification repo

The `modelcontextprotocol/modelcontextprotocol` repo has versioned schemas at
`schema/{version}/schema.ts` u2014 pure TypeScript, zero imports, zero Zod.

Available versions:
- `2024-11-05` u2014 baseline (31 KB)
- `2025-03-26` u2014 (34 KB)
- `2025-06-18` u2014 (42 KB)
- `2025-11-25` u2014 (67 KB) u2014 **recommended target** (stable release, has all types we need)
- `draft` u2014 (93 KB, `DRAFT-2026-v1`) u2014 unstable, has tasks/elicitation

This repo is `private: true` / not on npm. We'd copy a specific version's `schema.ts`
into our tree (it's self-contained).

**Every pure type ext-apps imports is defined here**: `CallToolRequest`, `CallToolResult`,
`Tool`, `Implementation`, `ContentBlock`, `EmbeddedResource`, `ResourceLink`,
`JSONRPCMessage`, `PingRequest`, `EmptyResult`, etc.

**Not defined here**: `Transport` interface, `ProtocolOptions`, `RequestOptions`,
`RequestHandlerExtra` u2014 these are SDK concepts, not protocol concepts.

### For Protocol: Minimal shim (~300 lines)

The full V2 Protocol is 1,081 lines with ~10,700 lines of transitive deps. ext-apps
uses a narrow surface:

```
connect(transport)              u2014 wire up transport callbacks
close()                         u2014 tear down
setRequestHandler(schema, fn)   u2014 register handler keyed by schema.shape.method.value
setNotificationHandler(schema, fn) u2014 same pattern
request(req, resultSchema, options) u2014 send request, correlate response, validate result
notification(notif, options)    u2014 send one-way message
onclose? / onerror?             u2014 callbacks
fallbackNotificationHandler?    u2014 catch-all
```

A minimal shim reproducing this surface is ~400-500 lines:
- JSON-RPC message routing (request/response correlation by ID)
- Handler map keyed by method string (extracted from schema at registration time)
- Timeout + AbortSignal support for outbound requests
- `notifications/cancelled` handler — aborts in-flight request handlers via AbortController
- `notifications/progress` handler — forwards to per-request progress callbacks, resets timeouts
- Auto-registered `ping` handler (returns `{}`)
- Zod schema validation on incoming requests
- `RequestHandlerExtra` construction (signal, sessionId, sendRequest, sendNotification)
- No task management, no capability negotiation, no auth

### Protocol features the shim MUST include

| Feature | Why | How it works in V2 Protocol |
|---------|-----|-----------------------------|
| Request/response correlation | Core JSON-RPC plumbing | Map of message ID → response handler promise |
| `notifications/cancelled` | Host/view can cancel in-flight requests | Auto-registered handler; calls `abortController.abort()` on matching request |
| `notifications/progress` | Progress updates reset timeouts | Auto-registered handler; forwards to per-request progress callback |
| `ping` auto-handler | Required by MCP spec | Auto-registered; returns `{}` |
| Timeout + maxTotalTimeout | Prevents hung requests | `setTimeout` per request; reset on progress if opted in |
| AbortSignal per request | Handler can observe cancellation | `AbortController` created per inbound request; passed in `extra.signal` |
| `RequestHandlerExtra` | Handler context object | `{ signal, sessionId, sendRequest, sendNotification }` |
| `onclose` / `onerror` callbacks | Lifecycle hooks | Called on transport close/error |
| `fallbackRequestHandler` / `fallbackNotificationHandler` | Catch-all for unknown methods | Checked when no specific handler matches |
| Debounced notifications | Batching for list-changed etc. | `_pendingDebouncedNotifications` map with `setTimeout` |

### For Zod schemas: Vendor from SDK or regenerate

**Handler routing schemas** (11): These are only needed to extract the method string
and validate incoming params. With the vendored Protocol shim, we keep the V1 API
(`setRequestHandler(schema, handler)`) so these still work. We can define minimal
Zod schemas ourselves:

```typescript
import { z } from 'zod/v4';
export const CallToolRequestSchema = z.object({
    method: z.literal('tools/call'),
    params: z.object({ name: z.string(), arguments: z.record(z.unknown()).optional() }).passthrough()
}).passthrough();
```

**Result validation schemas** (7): Same approach u2014 define minimal Zod schemas matching
the spec types. Or skip validation entirely (the SDK's V2 approach).

**Composition schemas** (7 in `generated/schema.ts`): These are the trickiest.
`ContentBlockSchema`, `ToolSchema`, etc. are used to compose ext-apps' own schemas.

**Recommended: Generate all MCP Zod schemas from the spec types using `ts-to-zod`**,
the same tool ext-apps already uses for its own `spec.types.ts` u2192 `generated/schema.ts`
pipeline. The workflow:

1. Copy `schema/2025-11-25/schema.ts` into `src/vendor/mcp-types.ts`
2. Add a `generate:mcp-schemas` script that runs `ts-to-zod` on `mcp-types.ts`
   outputting to `src/vendor/mcp-schemas.generated.ts`
3. Update `src/generated/schema.ts` to import from `../vendor/mcp-schemas.generated.ts`
   instead of from `@modelcontextprotocol/sdk/types.js`

This gives us Zod schemas for everything u2014 request routing, result validation,
schema composition, and wire validation u2014 all generated from a single source of truth.

**Wire validation** (`JSONRPCMessageSchema`): Also generated by `ts-to-zod` from the
spec types which define `JSONRPCMessage`, `JSONRPCRequest`, `JSONRPCNotification`, etc.

---

## Architecture After Divorce

```
ext-apps/
u251cu2500u2500 src/
u2502   u251cu2500u2500 vendor/
u2502   u2502   u251cu2500u2500 protocol.ts          # Minimal Protocol shim (~450 lines)
u2502   u2502   u251cu2500u2500 transport.ts         # Transport interface (~30 lines)
u2502   u2502   u2514u2500u2500 mcp-types.ts         # Copy of spec schema/2025-11-25/schema.ts
u2502   u251cu2500u2500 generated/
u2502   u2502   u251cu2500u2500 schema.ts            # ext-apps schemas (existing, updated imports)
u2502   u2502   u2514u2500u2500 mcp-schemas.ts       # MCP Zod schemas (generated by ts-to-zod from mcp-types.ts)
u2502   u251cu2500u2500 events.ts                # ProtocolWithEvents u2014 import from vendor/protocol.ts
u2502   u251cu2500u2500 app.ts                   # Import types from vendor/mcp-types.ts
u2502   u251cu2500u2500 app-bridge.ts            # Import types from vendor/mcp-types.ts
u2502   u2514u2500u2500 ...
u251cu2500u2500 examples/                    # Still depend on SDK for McpServer, transports
u2514u2500u2500 docs/                        # Same
```

The `generated/mcp-schemas.ts` file is produced by `ts-to-zod` from `vendor/mcp-types.ts`
using the same pipeline ext-apps already uses for its own `spec.types.ts` u2192 `generated/schema.ts`.
This gives us Zod schemas for all MCP types: `CallToolRequestSchema`, `JSONRPCMessageSchema`,
`ContentBlockSchema`, etc. u2014 all from a single versioned source of truth.

### What stays as SDK dependency

- **`examples/`** and **`docs/`**: These use `McpServer`, `StdioServerTransport`,
  `StreamableHTTPServerTransport`, `createMcpExpressApp`, `ResourceTemplate` u2014 all
  server-side SDK classes. They stay as SDK dependencies (moved to devDependencies).

- **`src/server/index.ts`**: Uses `McpServer` types (`RegisteredTool`, `ToolCallback`,
  etc.) as `import type`. Can be made into an optional peer dependency, or the types
  can be copied.

- **`Client` class** (`src/app-bridge.ts`, `src/react/useApp.tsx`): Used as a runtime
  dependency for the host-side `AppBridge`. Options:
  1. Keep `@modelcontextprotocol/client` (V2) as a peer dependency for hosts
  2. Vendor the Client class too (much larger surface u2014 not recommended)
  3. Accept `Client` via dependency injection (pass a client-like interface)

### Recommended approach for Client

Define a minimal `McpClient` interface that `AppBridge` needs:

```typescript
export interface McpClient {
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    getServerCapabilities(): ServerCapabilities | undefined;
    request<T>(request: { method: string; params?: Record<string, unknown> }, schema?: unknown): Promise<T>;
    setNotificationHandler(schema: unknown, handler: (notification: unknown) => void): void;
}
```

AppBridge's constructor takes `McpClient` instead of `Client`. Hosts using the MCP SDK
pass their `Client` instance (it satisfies this interface). ext-apps doesn't import Client.

---

## Spec Version Selection

| Option | Pros | Cons |
|--------|------|------|
| `2025-11-25` (latest stable) | Stable, has `ContentBlock`, `ResourceLink`, `ToolAnnotations` | Missing tasks/elicitation (ext-apps doesn't use them) |
| `draft` (DRAFT-2026-v1) | Most complete | Unstable, 93 KB, includes unused types |
| Cherry-pick from `2025-11-25` | Only the types ext-apps uses | Manual maintenance |

**Recommendation**: Use `2025-11-25` as the base. It has everything ext-apps needs.
If we later need draft-only types, cherry-pick them.

---

## Migration Steps

### Phase 1: Vendor Protocol + Transport (no SDK changes yet)

1. Create `src/vendor/protocol.ts` u2014 minimal Protocol shim with V1 generic signature
2. Create `src/vendor/transport.ts` u2014 Transport interface
3. Update `src/events.ts` to import from `./vendor/protocol.ts`
4. Verify all tests pass with vendored Protocol

### Phase 2: Vendor MCP Types

1. Copy `schema/2025-11-25/schema.ts` into `src/vendor/mcp-types.ts`
2. Update all `import type { ... } from '@modelcontextprotocol/sdk/types.js'` to
   `import type { ... } from './vendor/mcp-types.js'`
3. Create `src/mcp-schemas.ts` with minimal Zod schemas for the MCP request/result
   types that ext-apps uses at runtime
4. Update `src/generated/schema.ts` to import Zod schemas from `src/mcp-schemas.ts`
   instead of from the SDK

### Phase 3: Abstract Client dependency

1. Define `McpClient` interface in `src/vendor/client-interface.ts`
2. Update `AppBridge` to accept `McpClient` instead of `Client`
3. Move `@modelcontextprotocol/sdk` to `peerDependencies` (optional) for hosts
   that want to pass an SDK `Client`

### Phase 4: Clean up

1. Remove `@modelcontextprotocol/sdk` from `dependencies`
2. Keep in `devDependencies` for examples/ only
3. Update `src/server/index.ts` to use `import type` from peer dep or vendored types
4. Update all examples/ to import from V2 SDK packages

---

## Estimated Effort

| Phase | Files changed | New code | Risk |
|-------|--------------|----------|------|
| 1. Vendor Protocol | 3-4 | ~450 lines | Medium u2014 must match V1 behavior (cancel, timeout, progress) |
| 2. Vendor MCP Types + Schemas | 8-10 | ~0 hand-written (generated by ts-to-zod) + copy spec | Low u2014 same codegen pipeline as existing |
| 3. Abstract Client | 3-4 | ~30 lines (interface) | Low u2014 structural subtyping |
| 4. Clean up | 5-10 | 0 | Low u2014 import path changes |

Total hand-written code: ~480 lines (Protocol shim + interface).
Generated code: MCP Zod schemas (via ts-to-zod, same pipeline as today).
Spec types file: ~67 KB copied from spec repo (2025-11-25 version).
