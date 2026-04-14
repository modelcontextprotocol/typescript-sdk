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

A minimal shim reproducing this surface is ~300 lines:
- JSON-RPC message routing (request/response correlation by ID)
- Handler map keyed by method string (extracted from schema at registration time)
- Timeout + AbortSignal support
- Zod schema validation on incoming requests and outgoing results
- No task management, no capability negotiation, no auth

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
Options:
1. Vendor the specific Zod schemas from SDK 1.29.0 source
2. Regenerate from the spec schema.ts using `ts-to-zod` (ext-apps already uses this)
3. Hand-write minimal versions

**Wire validation** (1): `JSONRPCMessageSchema` u2014 vendor or redefine. It's a simple
discriminated union.

---

## Architecture After Divorce

```
ext-apps/
u251cu2500u2500 src/
u2502   u251cu2500u2500 vendor/
u2502   u2502   u251cu2500u2500 protocol.ts          # Minimal Protocol shim (~300 lines)
u2502   u2502   u251cu2500u2500 transport.ts         # Transport interface (~30 lines)
u2502   u2502   u251cu2500u2500 jsonrpc.ts           # JSONRPCMessage types + validation schema
u2502   u2502   u2514u2500u2500 mcp-types.ts         # Copy of spec schema.ts (chosen version)
u2502   u251cu2500u2500 generated/
u2502   u2502   u2514u2500u2500 schema.ts            # Updated: import from vendor/ instead of SDK
u2502   u251cu2500u2500 mcp-schemas.ts           # Minimal Zod schemas for MCP request/result types
u2502   u251cu2500u2500 events.ts                # ProtocolWithEvents u2014 import from vendor/protocol.ts
u2502   u251cu2500u2500 app.ts                   # Import types from vendor/mcp-types.ts
u2502   u251cu2500u2500 app-bridge.ts            # Import types from vendor/mcp-types.ts
u2502   u2514u2500u2500 ...
u251cu2500u2500 examples/                    # Still depend on SDK for McpServer, transports
u2514u2500u2500 docs/                        # Same
```

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
| 1. Vendor Protocol | 3-4 | ~350 lines | Medium u2014 must match V1 behavior exactly |
| 2. Vendor MCP Types | 8-10 | ~100 lines (schemas) + copy spec | Low u2014 type-only changes except schemas |
| 3. Abstract Client | 3-4 | ~30 lines (interface) | Low u2014 structural subtyping |
| 4. Clean up | 5-10 | 0 | Low u2014 import path changes |

Total new code: ~480 lines (Protocol shim + schemas + interface).
Spec types file: ~67 KB copied from spec repo (2025-11-25 version).
