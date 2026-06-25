---
name: migrate-v1-to-v2
description: Migrate MCP TypeScript SDK code from v1 (@modelcontextprotocol/sdk) to v2 (@modelcontextprotocol/core, /client, /server). Use when a user asks to migrate, upgrade, or port their MCP TypeScript code from v1 to v2.
---

# Upgrading from v1.x to v2

This guide covers upgrading from `@modelcontextprotocol/sdk` (v1.x) to the v2 packages.
It is written for shell-capable agents and humans alike: run the codemod first, then
work through the manual sections for what the codemod can't rewrite.

If you are already on v2 and want to adopt the **2026-07-28 protocol revision**, see
[support-2026-07-28.md](./support-2026-07-28.md) instead.

## TL;DR — quick path

1. **Prerequisites.** Node.js 20+ and ESM (`"type": "module"` or `.mts`). v2 ships ESM
   only; CommonJS callers must use dynamic `import()`.
2. **Run the codemod.**
   ```bash
   npx @modelcontextprotocol/codemod@alpha v1-to-v2 ./src
   ```
3. **Grep for markers.** Anything the codemod recognized but could not safely rewrite is
   marked in place:
   ```bash
   grep -rn '@mcp-codemod-error' .
   ```
4. **Type-check.** `tsc --noEmit` (or your build). Remaining errors map to the
   [manual sections](#manual-changes-what-the-codemod-does-not-handle) below.
5. **Format.** The codemod rewrites the AST without reformatting — run your formatter on
   the changed files (`prettier --write` / `eslint --fix` / `biome format --write`); the
   codemod prints the exact command after it runs.
6. **Run your tests.**

## Contents

- [What the codemod handles](#what-the-codemod-handles)
- [What the codemod does NOT handle](#what-the-codemod-does-not-handle)
- [Manual changes](#manual-changes-what-the-codemod-does-not-handle)
    - [Packaging & runtime](#packaging--runtime)
    - [Imports & transports](#imports--transports)
    - [Low-level protocol & handler context (`ctx`)](#low-level-protocol--handler-context-ctx)
    - [Server registration API](#server-registration-api)
    - [HTTP & headers](#http--headers)
    - [Errors](#errors)
    - [Auth](#auth)
    - [Types & schemas](#types--schemas)
    - [Behavioral changes](#behavioral-changes)
- [Enhancements](#enhancements)
- [Unchanged APIs](#unchanged-apis)
- [Need help?](#need-help)

---

## What the codemod handles

The codemod ([`@modelcontextprotocol/codemod`](../../packages/codemod/README.md))
mechanically applies every rename whose mapping is fixed. The mappings are the
**source of truth** — they live in the codemod package and are not reproduced here:

| Mapping | Source file |
| --- | --- |
| `@modelcontextprotocol/sdk/...` import paths → v2 packages | [`mappings/importMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts) |
| Symbol renames (`McpError` → `ProtocolError`, `JSONRPCError` → `JSONRPCErrorResponse`, …) | [`mappings/symbolMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/symbolMap.ts) |
| `setRequestHandler(Schema, …)` → `setRequestHandler('method/string', …)` | [`mappings/schemaToMethodMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts) |
| `extra.*` → `ctx.mcpReq.*` / `ctx.http?.*` property remap | [`mappings/contextPropertyMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/contextPropertyMap.ts) |

In addition the codemod:

- Updates `package.json` dependencies (`@modelcontextprotocol/sdk` → the v2 packages
  your imports actually use).
- Rewrites `.tool()` / `.prompt()` / `.resource()` to `registerTool` / `registerPrompt`
  / `registerResource` and wraps `inputSchema` / `outputSchema` / `argsSchema` /
  `uriSchema` raw Zod shapes with `z.object()`.
- Drops the result-schema argument from `client.request()` / `client.callTool()` for
  spec methods.
- Routes the spec Zod `*Schema` constants imported from `sdk/types.js` to
  `@modelcontextprotocol/core` (mixed imports are split; `.parse()` / `.safeParse()`
  calls are left untouched). The task-handler schema constants
  (`GetTaskRequestSchema` etc.) used as `setRequestHandler` args are mapped to their
  method strings (`'tasks/get'` etc.) like every other handler schema.
- Renames `ErrorCode` → `ProtocolErrorCode` and routes the local-only members
  (`RequestTimeout`, `ConnectionClosed`) to `SdkErrorCode`.
- Renames every `StreamableHTTPError` reference to `SdkHttpError` and adds the import
  (constructor calls are marked for review — argument shape changed).
- Replaces `IsomorphicHeaders` with the Web Standard `Headers` type and drops the
  import (a warning notes `Headers` uses `.get()`/`.set()`, not bracket access).
- Rewrites `SchemaInput<T>` → `StandardSchemaWithJSON.InferInput<T>`.
- Renames `RequestHandlerExtra` → `ServerContext` / `ClientContext` and the `extra`
  parameter to `ctx`.
- Rewrites `vi.mock` / `jest.mock` and dynamic `import()` paths.
- Renames the `ResourceTemplate` **type** imported from `@modelcontextprotocol/sdk/types.js`
  to `ResourceTemplateType` (the spec wire type). The `ResourceTemplate` URI-template
  helper **class** from `server/mcp.js` keeps its name and is not renamed.
- Drops `@modelcontextprotocol/sdk/server/zod-compat.js` imports.

## What the codemod does NOT handle

Each of these maps to a manual section below. The codemod marks every site it
recognized but could not safely rewrite with an `@mcp-codemod-error` comment.

- **Node 20 / ESM** — pre-flight, not a code rewrite. → [Packaging & runtime](#packaging--runtime)
- **`new Headers()` / `.get()` rewrite** — `IsomorphicHeaders` is renamed to `Headers`
  and `extra.requestInfo?.headers[…]` is remapped to `ctx.http?.req?.headers[…]`, but
  converting bracket access to `.get()` and wrapping plain objects with `new Headers()`
  is manual. → [HTTP & headers](#http--headers)
- **`ctx.mcpReq.send()` schema-arg drop** — the codemod drops the schema arg from
  `client.request()` / `client.callTool()` but leaves nested `ctx.mcpReq.send()` calls
  alone. → [Low-level protocol](#low-level-protocol--handler-context-ctx)
- **OAuth error-class consolidation** — `instanceof InvalidGrantError` → `OAuthError` +
  `OAuthErrorCode` is a judgment rewrite. → [Auth](#auth)
- **`SdkErrorCode` branch selection** — the codemod renames `StreamableHTTPError` →
  `SdkHttpError`; deciding which `SdkErrorCode` branch a given catch should match is
  judgment. → [Errors](#errors)
- **Namespace schema access** — `import * as t from '…/types.js'` +
  `t.CallToolResultSchema.parse(…)` can't be split per-symbol; the codemod flags it
  action-required — re-import the schema from `@modelcontextprotocol/core` by hand.
  → [Types & schemas](#types--schemas)
- **Behavioral adaptation** — list auto-aggregation, capability empties, lazy validator
  compilation, output-schema validation rules. → [Behavioral changes](#behavioral-changes)

---

## Manual changes (what the codemod does not handle)

### Packaging & runtime

The single `@modelcontextprotocol/sdk` package is split:

| v1 | v2 |
| --- | --- |
| `@modelcontextprotocol/sdk` | `@modelcontextprotocol/client` (client implementation) |
| | `@modelcontextprotocol/server` (server implementation) |
| | `@modelcontextprotocol/core` (internal — never import directly) |
| Built-in HTTP framework support | `@modelcontextprotocol/node` / `@modelcontextprotocol/express` / `@modelcontextprotocol/hono` / `@modelcontextprotocol/fastify` |

`@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export shared
types from `@modelcontextprotocol/core`, so import types and error classes from
whichever package you already depend on. **Do not import from `@modelcontextprotocol/core`
directly.**

The framework adapter packages declare their framework as a **peer dependency**
(`express`, `hono`, `fastify`); v1 shipped them as direct deps. The codemod adds the
`@modelcontextprotocol/*` packages your imports use, but does not add the framework
peer — install it explicitly (`pnpm add express` etc.). `@modelcontextprotocol/node`
depends on `@hono/node-server` at runtime (Node HTTP ↔ Web Standard conversion) but
does **not** require the `hono` framework — your package manager may emit a harmless
unmet-peer warning for `hono` (upstream `@hono/node-server` declares it).

v2 requires **Node.js 20+** and ships **ESM only**. If your project uses CommonJS
(`require()`), either migrate to ESM or use dynamic `import()`.

### Imports & transports

The codemod rewrites every `@modelcontextprotocol/sdk/...` import path via
[`importMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts).
A few transports need a decision the codemod can't make:

- **`StreamableHTTPServerTransport` → which runtime?** The codemod renames it to
  `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node`. If you deploy
  to a web-standard runtime (Cloudflare Workers, Deno, Bun), use
  `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`
  instead. **Decision rule:** if your handler receives a Node `IncomingMessage` /
  `ServerResponse`, use `@modelcontextprotocol/node`; if it receives a web-standard
  `Request` and returns a `Response`, use `@modelcontextprotocol/server`.
- **stdio transports moved to a `./stdio` subpath.** Import `StdioClientTransport`,
  `getDefaultEnvironment`, `DEFAULT_INHERITED_ENV_VARS`, and `StdioServerParameters`
  from `@modelcontextprotocol/client/stdio`; import `StdioServerTransport` from
  `@modelcontextprotocol/server/stdio`. The package root barrels do **not** export
  these (the root entries are runtime-neutral so browser/Workers bundlers can consume
  them). The stdio utilities `ReadBuffer`, `serializeMessage`, `deserializeMessage`
  stay in the root barrel.
- **Zod `*Schema` constants → `@modelcontextprotocol/core`.** A mixed
  `import { CallToolResult, CallToolResultSchema } from '…/types.js'` is split by the
  codemod — see [Types & schemas](#types--schemas).

  ```typescript
  // v1
  import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
  // v2
  import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
  ```

- **`SSEServerTransport`** is removed. Migrate to Streamable HTTP. A frozen v1 copy is
  available from `@modelcontextprotocol/server-legacy/sse` as a temporary bridge.
- **`WebSocketClientTransport`** is removed (WebSocket is not a spec transport). Use
  `StreamableHTTPClientTransport` for remote servers or `StdioClientTransport` for
  local servers; the `Transport` interface is exported if you need a custom
  implementation.
- **`InMemoryTransport`** is now exported from `@modelcontextprotocol/client` and
  `@modelcontextprotocol/server` (both re-export it):

  ```typescript
  // v1
  import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
  // v2
  import { InMemoryTransport } from '@modelcontextprotocol/server'; // or /client
  ```

- **`EventStore`, `StreamId`, `EventId`** are exported from `@modelcontextprotocol/server`
  only (v1 re-exported them alongside the transport from `sdk/server/streamableHttp.js`;
  `@modelcontextprotocol/node` does not).
- **Server auth split.** Resource Server helpers (`requireBearerAuth`,
  `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`)
  → `@modelcontextprotocol/express`. Authorization Server helpers (`mcpAuthRouter`,
  `OAuthServerProvider`, `ProxyOAuthServerProvider`, `allowedMethods`,
  `authenticateClient`, `metadataHandler`, `createOAuthMetadata`,
  `authorizationHandler` / `tokenHandler` / `revocationHandler` /
  `clientRegistrationHandler`) → `@modelcontextprotocol/server-legacy/auth`
  (deprecated, frozen v1 copy); migrate AS to a dedicated IdP/OAuth library. `AuthInfo`
  is now re-exported by `@modelcontextprotocol/client` and `@modelcontextprotocol/server`.

  The codemod's [`importMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts)
  routes every `…/server/auth/**` deep path (including
  `…/server/auth/middleware/{bearerAuth,allowedMethods,clientAuth}.js`,
  `…/server/auth/handlers/*.js`, `…/server/auth/providers/proxyProvider.js`) to
  `@modelcontextprotocol/server-legacy/auth`, and `…/server/express.js` /
  `…/server/middleware/hostHeaderValidation.js` to `@modelcontextprotocol/express`. The
  AS→`server-legacy` routing is conservative — re-point RS-only call sites
  (`requireBearerAuth`, `mcpAuthMetadataRouter`) at `@modelcontextprotocol/express` by hand.

### Low-level protocol & handler context (`ctx`)

The second parameter to every request handler — previously the flat `RequestHandlerExtra`
object named `extra` — is now a structured **context** object named `ctx`. This is the
`ctx` that appears throughout the rest of this guide.

The codemod renames the parameter and remaps property access via
[`contextPropertyMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/contextPropertyMap.ts).
A few mappings need optional-chaining adjustment (the `http` group is `undefined` on
stdio):

| v1 (`extra.*`) | v2 (`ctx.*`) | Note |
| --- | --- | --- |
| `extra.signal` | `ctx.mcpReq.signal` | |
| `extra.requestId` | `ctx.mcpReq.id` | |
| `extra._meta` | `ctx.mcpReq._meta` | |
| `extra.sendRequest(...)` | `ctx.mcpReq.send(...)` | |
| `extra.sendNotification(...)` | `ctx.mcpReq.notify(...)` | |
| `extra.sessionId` | `ctx.sessionId` | |
| `extra.authInfo` | `ctx.http?.authInfo` | optional — `undefined` on stdio |
| `extra.requestInfo` | `ctx.http?.req` | a standard Web `Request`; `ServerContext` only |
| `extra.closeSSEStream` | `ctx.http?.closeSSE` | `ServerContext` only |
| `extra.closeStandaloneSSEStream` | `ctx.http?.closeStandaloneSSE` | `ServerContext` only |
| `extra.taskStore` / `taskId` / `taskRequestedTtl` | _removed_ | see [Experimental tasks](#experimental-tasks-interception-removed) |

`BaseContext` is the common base; `ServerContext` and `ClientContext` extend it.
`ServerContext.mcpReq` adds convenience methods that replace calling `server.*` from
inside a handler:

| `ctx.mcpReq.*` (new) | Replaces (inside a handler) |
| --- | --- |
| `ctx.mcpReq.log(level, data, logger?)` | `server.sendLoggingMessage(...)` — ⚠ **`@deprecated`**, see [§Deprecated in v2](#deprecated-in-v2-sep-2577) |
| `ctx.mcpReq.elicitInput(params, options?)` | `server.elicitInput(...)` |
| `ctx.mcpReq.requestSampling(params, options?)` | `server.createMessage(...)` — ⚠ **`@deprecated`**, see [§Deprecated in v2](#deprecated-in-v2-sep-2577) |

#### Deprecated in v2 (SEP-2577)

The roots, sampling, and logging subsystems are deprecated as of protocol version
2026-07-28 (SEP-2577). Everything below is **still fully functional in v2** and marked
`@deprecated` for removal in a later major; on a 2026-07-28 connection prefer the
[multi-round-trip `input_required` pattern](./support-2026-07-28.md#multi-round-trip-requests)
instead.

- **Runtime APIs**: `Server.createMessage` / `listRoots` / `sendLoggingMessage`,
  `McpServer.sendLoggingMessage`, `Client.setLoggingLevel` / `sendRootsListChanged`, and
  the `ctx.mcpReq.log` / `ctx.mcpReq.requestSampling` handler-context helpers.
- **Capability fields**: the `roots`, `sampling`, and `logging` capability schema fields.
- **Type stacks**: the full Logging stack (`LoggingLevel`, `SetLevelRequest`,
  `LoggingMessageNotification` and params), the full Sampling stack
  (`CreateMessageRequest`/`Result`, `SamplingMessage`, `ModelPreferences`/`ModelHint`,
  `ToolChoice`, `ToolUseContent`/`ToolResultContent`, the `includeContext` enum values),
  and the full Roots stack (`Root`, `ListRootsRequest`/`Result`,
  `RootsListChangedNotification`).
- **`registerClient`** (Dynamic Client Registration) — prefer Client ID Metadata
  Documents per SEP-991.

JSDoc/types only — wire behavior is unchanged and remains functional for at least the
twelve-month deprecation window.

#### `setRequestHandler` / `setNotificationHandler` use method strings

The low-level handler registration takes a **method string** instead of a Zod schema.
The codemod rewrites every spec-method registration via
[`schemaToMethodMap.ts`](../../packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts).

```typescript
// v1
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => { ... });
// v2
server.setRequestHandler('tools/call', async (request, ctx) => { ... });
```

**Custom (non-spec) methods** use the 3-arg form `(method, { params, result? }, handler)`
where `params` and `result` are any [Standard Schema](https://standardschema.dev). The
handler receives the parsed `params` directly (not the full request envelope); `_meta`
is at `ctx.mcpReq._meta`. The 3-arg notification handler is `(params, notification) => void`.

```typescript
server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, ctx) => { ... });
```

#### `request()`, `ctx.mcpReq.send()`, and `callTool()` no longer require a schema for spec methods

For **spec** methods, drop the result-schema argument; the SDK resolves it from the
method name. The codemod drops it from `client.request()` and `client.callTool()`; drop
it from `ctx.mcpReq.send()` by hand.

```typescript
// v1
import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const r = await extra.sendRequest({ method: 'sampling/createMessage', params: { ... } }, CreateMessageResultSchema);
    return { content: [{ type: 'text', text: 'done' }] };
});

// v2
server.setRequestHandler('tools/call', async (request, ctx) => {
    const r = await ctx.mcpReq.send({ method: 'sampling/createMessage', params: { ... } });
    return { content: [{ type: 'text', text: 'done' }] };
});
```

For **custom (non-spec)** methods, keep the result-schema argument:
`await client.request({ method: 'acme/search', params }, SearchResult)` — only drop the
schema when calling a spec method.

The return type is inferred from the method name via `ResultTypeMap` (e.g.
`client.request({ method: 'tools/call', ... })` returns `Promise<CallToolResult>`).

### Server registration API

The deprecated variadic `.tool()`, `.prompt()`, `.resource()` are removed. Use
`registerTool` / `registerPrompt` / `registerResource` with an explicit config object.
The codemod converts the call shape and wraps `inputSchema` / `outputSchema` /
`argsSchema` / `uriSchema` raw shapes.

```typescript
// v1 — raw shape, variadic
server.tool('greet', 'Greet a user', { name: z.string() }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// v2 — config object, Standard Schema
server.registerTool(
    'greet',
    { description: 'Greet a user', inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => {
        return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
    }
);
```

`registerResource` requires a `metadata` argument — pass `{}` if you have none.

#### Standard Schema objects (raw shapes deprecated)

v2 expects schema objects implementing the [Standard Schema spec](https://standardschema.dev/)
for `inputSchema`, `outputSchema`, and `argsSchema`. Raw `{ field: z.string() }` shapes
are still **accepted via `@deprecated` overloads** on `registerTool`/`registerPrompt`
(auto-wrapped with `z.object()`), and `completable()` accepts any `StandardSchemaV1`;
prefer wrapping explicitly. Zod v4, ArkType, and Valibot all implement the spec.

**Zod v3 is no longer supported** (v1 peer was `^3.25 || ^4.0`). Passing a Zod v3 schema
hard-errors with a pointer at `fromJsonSchema()`; Zod 4.0–4.1 schemas (which lack
`~standard.jsonSchema`) work via a bundled fallback with a one-time console warning.
Upgrade to `zod ^4.2.0` or use another Standard Schema library.

```typescript
import * as z from 'zod/v4';
server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, handler);

// ArkType works too
import { type } from 'arktype';
server.registerTool('greet', { inputSchema: type({ name: 'string' }) }, handler);

// Raw JSON Schema via fromJsonSchema (validator defaults to runtime-appropriate choice)
import { fromJsonSchema } from '@modelcontextprotocol/server';
server.registerTool('greet', { inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } } }) }, handler);

// No-parameter tools: z.object({})
```

Removed Zod-specific helpers (the codemod marks each call site `@mcp-codemod-error`):
`schemaToJson` — use `fromJsonSchema()` from `@modelcontextprotocol/server` for raw JSON
Schema, or your schema library's native JSON-Schema conversion; `parseSchemaAsync` — use
your schema library's validation directly (e.g. Zod's `.safeParseAsync()`);
`getSchemaShape` / `getSchemaDescription` / `isOptionalSchema` / `unwrapOptionalSchema`
have no replacement (internal Zod introspection). `SchemaInput<T>` →
`StandardSchemaWithJSON.InferInput<T>` is rewritten mechanically by the codemod. The
internal `standardSchemaToJsonSchema` / `validateStandardSchema` helpers are **not** part
of the public surface — do not import them.

### HTTP & headers

Transport APIs and `ctx.http?.req?.headers` use the Web Standard `Headers` object
(`IsomorphicHeaders` is removed). `ctx.http?.req` is a standard Web `Request`.

```typescript
// v1
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer token' } }
});
const sessionId = extra.requestInfo?.headers['mcp-session-id'];

// v2
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: new Headers({ Authorization: 'Bearer token' }) }
});
const sessionId = ctx.http?.req?.headers.get('mcp-session-id');
const debug = new URL(ctx.http!.req!.url).searchParams.get('debug');
```

`StreamableHTTPClientTransport` now **appends** any custom `requestInit.headers.Accept`
value to the spec-required `application/json, text/event-stream` (v1 let it replace
them). The required media types are always present; additional types are kept for
proxy/gateway routing.

`hostHeaderValidation()` and `localhostHostValidation()` moved to
`@modelcontextprotocol/express`. The `(allowedHostnames: string[])` signature is the
same as every released v1.x — only the import path changes. Framework-agnostic helpers
(`validateHostHeader`, `localhostAllowedHostnames`, `hostHeaderValidationResponse`) are
in `@modelcontextprotocol/server`.

### Errors

The SDK now distinguishes three error kinds:

1. **`ProtocolError`** (renamed from `McpError`) — protocol errors that cross the wire
   as JSON-RPC error responses. Uses `ProtocolErrorCode` (renamed from `ErrorCode`).
2. **`SdkError`** — local SDK errors that never cross the wire. Uses `SdkErrorCode`.
3. **`SdkHttpError`** (extends `SdkError`) — HTTP transport errors with typed `.status`
   and `.statusText`.

The codemod renames `McpError` → `ProtocolError`, `ErrorCode` → `ProtocolErrorCode`
(routing `RequestTimeout` / `ConnectionClosed` to `SdkErrorCode`), and
`StreamableHTTPError` → `SdkHttpError`. After the codemod runs, your `instanceof`
checks already name the v2 classes — what's left is choosing which `SdkErrorCode` /
class to match per scenario:

| Scenario | v1 | v2 |
| --- | --- | --- |
| Request timeout | `McpError` + `ErrorCode.RequestTimeout` | `SdkError` + `SdkErrorCode.RequestTimeout` |
| Connection closed | `McpError` + `ErrorCode.ConnectionClosed` | `SdkError` + `SdkErrorCode.ConnectionClosed` |
| Capability not supported | `new Error(...)` | `SdkError` + `SdkErrorCode.CapabilityNotSupported` |
| Not connected | `new Error('Not connected')` | `SdkError` + `SdkErrorCode.NotConnected` |
| Response result fails schema | raw `ZodError` | `SdkError` + `SdkErrorCode.InvalidResult` |
| Invalid params (server response) | `McpError` + `ErrorCode.InvalidParams` | `ProtocolError` + `ProtocolErrorCode.InvalidParams` |
| HTTP transport error | `StreamableHTTPError` | `SdkHttpError` + `SdkErrorCode.ClientHttp*` |
| Failed to open SSE stream | `StreamableHTTPError` | `SdkHttpError` + `SdkErrorCode.ClientHttpFailedToOpenStream` |
| 401 after re-auth (circuit break) | `StreamableHTTPError` | `SdkHttpError` + `SdkErrorCode.ClientHttpAuthentication` |
| `SSEClientTransport.send()` 401 after re-auth | `UnauthorizedError` | `SdkHttpError` + `SdkErrorCode.ClientHttpAuthentication` |
| 403 `insufficient_scope` after step-up retry cap | `StreamableHTTPError` | `SdkHttpError` + `SdkErrorCode.ClientHttpForbidden` |
| Unexpected content type | `StreamableHTTPError` | `SdkError` + `SdkErrorCode.ClientHttpUnexpectedContent` |
| Session termination failed | `StreamableHTTPError` | `SdkHttpError` + `SdkErrorCode.ClientHttpFailedToTerminateSession` |

```typescript
// v1
if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) { ... }
if (error instanceof StreamableHTTPError) { console.log('HTTP status:', error.code); }

// v2
import { SdkError, SdkHttpError, SdkErrorCode, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) { ... }
if (error instanceof SdkHttpError) {
    console.log('HTTP status:', error.status, error.statusText);
    switch (error.code) {
        case SdkErrorCode.ClientHttpAuthentication:
        case SdkErrorCode.ClientHttpForbidden:
        case SdkErrorCode.ClientHttpFailedToOpenStream:
        case SdkErrorCode.ClientHttpNotImplemented:
            break;
    }
}
```

`StreamableHTTPError` is removed.

#### `SdkErrorCode` enum (complete)

| Code | When thrown |
| --- | --- |
| `NotConnected` | Transport is not connected |
| `AlreadyConnected` | Transport is already connected |
| `NotInitialized` | Protocol is not initialized |
| `CapabilityNotSupported` | Required capability is not supported |
| `RequestTimeout` | Request timed out waiting for response |
| `ConnectionClosed` | Connection was closed |
| `SendFailed` | Failed to send message |
| `InvalidResult` | Response result failed local schema validation |
| `UnsupportedResultType` | A 2026-era response carried an unrecognized `resultType` |
| `InputRequiredRoundsExceeded` | Multi-round-trip auto-fulfilment hit `maxRounds` |
| `ListPaginationExceeded` | No-arg `list*()` aggregate walk hit `listMaxPages` |
| `MethodNotSupportedByProtocolVersion` | Outbound spec method does not exist on the negotiated protocol version |
| `EraNegotiationFailed` | `connect()` could not negotiate a protocol era (probe failed / no overlap) |
| `ClientHttpNotImplemented` | HTTP POST request failed |
| `ClientHttpAuthentication` | Server returned 401 after re-authentication |
| `ClientHttpForbidden` | Server returned 403 `insufficient_scope` after step-up retry cap |
| `ClientHttpUnexpectedContent` | Unexpected content type in HTTP response |
| `ClientHttpFailedToOpenStream` | Failed to open SSE stream |
| `ClientHttpFailedToTerminateSession` | Failed to terminate session |

#### Typed `ProtocolError` subclasses

`ResourceNotFoundError` (carries `.uri`) and `MissingRequiredClientCapabilityError`
(carries `data.requiredCapabilities`) are new typed `ProtocolError` subclasses.
`resources/read` for an unknown URI now answers `-32602` on every protocol revision
(v1.x already emitted `-32602`; an interim `-32002` from earlier v2 alphas is mapped at
the encode seam). `ProtocolErrorCode.ResourceNotFound` (`-32002`) stays importable as
receive-tolerated vocabulary — accept both `-32602` and `-32002` from peers.
`ProtocolError.fromError(code, message, data)` reconstructs the typed subclass from
code + data alone, so it works across bundle boundaries where `instanceof` doesn't.

### Auth

#### OAuth error consolidation

The individual OAuth error classes are replaced with a single `OAuthError` + `OAuthErrorCode`.
The `OAUTH_ERRORS` constant is removed. The codemod does not rewrite `instanceof` checks
on these classes — switch on `error.code` instead.

| v1 class | v2 equivalent |
| --- | --- |
| `InvalidRequestError` | `OAuthError` + `OAuthErrorCode.InvalidRequest` |
| `InvalidClientError` | `OAuthError` + `OAuthErrorCode.InvalidClient` |
| `InvalidGrantError` | `OAuthError` + `OAuthErrorCode.InvalidGrant` |
| `UnauthorizedClientError` | `OAuthError` + `OAuthErrorCode.UnauthorizedClient` |
| `UnsupportedGrantTypeError` | `OAuthError` + `OAuthErrorCode.UnsupportedGrantType` |
| `InvalidScopeError` | `OAuthError` + `OAuthErrorCode.InvalidScope` |
| `AccessDeniedError` | `OAuthError` + `OAuthErrorCode.AccessDenied` |
| `ServerError` | `OAuthError` + `OAuthErrorCode.ServerError` |
| `TemporarilyUnavailableError` | `OAuthError` + `OAuthErrorCode.TemporarilyUnavailable` |
| `UnsupportedResponseTypeError` | `OAuthError` + `OAuthErrorCode.UnsupportedResponseType` |
| `UnsupportedTokenTypeError` | `OAuthError` + `OAuthErrorCode.UnsupportedTokenType` |
| `InvalidTokenError` | `OAuthError` + `OAuthErrorCode.InvalidToken` |
| `MethodNotAllowedError` | `OAuthError` + `OAuthErrorCode.MethodNotAllowed` |
| `TooManyRequestsError` | `OAuthError` + `OAuthErrorCode.TooManyRequests` |
| `InvalidClientMetadataError` | `OAuthError` + `OAuthErrorCode.InvalidClientMetadata` |
| `InsufficientScopeError` | `OAuthError` + `OAuthErrorCode.InsufficientScope` ¹ |
| `InvalidTargetError` | `OAuthError` + `OAuthErrorCode.InvalidTarget` |
| `CustomOAuthError` | `new OAuthError(customCode, message)` |

¹ Unrelated to the new transport-layer `InsufficientScopeError` (SEP-2350) exported from
`@modelcontextprotocol/client`, which carries an RFC 6750 challenge from the resource
server and extends `OAuthClientFlowError`, **not** `OAuthError`. Do not rewrite that one.

```typescript
// v1
if (error instanceof InvalidClientError) { ... }
// v2
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidClient) { ... }
```

A frozen copy of the v1 classes (and `mcpAuthRouter`) is available from
`@modelcontextprotocol/server-legacy/auth` during migration.

#### `AuthProvider` — non-OAuth bearer auth and the widened `authProvider` option

The transport `authProvider` option is widened to `AuthProvider | OAuthClientProvider`.
**`AuthProvider`** is a new minimal interface — `{ token(): Promise<string | undefined>;
onUnauthorized?(ctx): Promise<void> }` — for static-token / non-OAuth bearer auth.
Transports call `token()` before every request and `onUnauthorized()` on 401 (then retry
once). Existing `OAuthClientProvider` implementations need no changes — transports adapt
them internally via the new `adaptOAuthProvider()` export. Also exported:
`isOAuthClientProvider()` (type guard) and `handleOAuthUnauthorized()` (the standard
OAuth `onUnauthorized` behavior, for composing your own adapter).

#### OAuth client flow — behavioral changes

- **Resolved scope passed to DCR (SEP-835).** `auth()` now computes the resolved scope
  once (WWW-Authenticate → PRM `scopes_supported` → `clientMetadata.scope`) and passes
  it to **both** the DCR POST body and the authorization request. `registerClient()`
  gained an optional `scope` parameter that overrides `clientMetadata.scope` in the
  registration body.
- **OAuth error on HTTP 200.** `exchangeAuthorization()` / `refreshAuthorization()` now
  throw `OAuthError` when the AS returns HTTP 200 with a JSON `{error: ...}` body (e.g.
  GitHub). v1 surfaced this as a Zod parse failure on the tokens schema.
- **Metadata discovery falls through on 502.** `discoverAuthorizationServerMetadata()`
  treats `502 Bad Gateway` like 4xx — fall through to the next candidate URL instead of
  throwing (fixes path-aware discovery behind reverse proxies). Other 5xx still throw.

#### OAuth client flow errors (new)

The OAuth client flow now throws dedicated classes from `@modelcontextprotocol/client`
(all extend `OAuthClientFlowError`, **not** `OAuthError` — `auth()`'s `OAuthError` retry
path will not catch them):

| Throw site | v2 class |
| --- | --- |
| `registerClient()` rejected by AS (⚠ `@deprecated` — see [§Deprecated in v2](#deprecated-in-v2-sep-2577)) | `RegistrationRejectedError` (`status`, `body`, `submittedMetadata`) |
| Token-exchange / refresh / `fetchToken` / Cross-App grant on a non-`https:` token endpoint | `InsecureTokenEndpointError` (`tokenEndpoint`) |
| RFC 9207 `iss` mismatch / RFC 8414 §3.3 issuer-echo mismatch | `IssuerMismatchError` (`kind`, `expected`, `received`) |
| Transport 403 `insufficient_scope` with `onInsufficientScope: 'throw'`, or default mode without an `OAuthClientProvider` | `InsufficientScopeError` (`requiredScope`, `resourceMetadataUrl`, `errorDescription`) |
| `auth()` callback leg: discovery resolves a different AS than the recorded redirect target | `AuthorizationServerMismatchError` (`recordedIssuer`, `currentIssuer`) |

#### `auth()` options are now `AuthOptions`

The inline options object on `auth()` is now the named `AuthOptions` type. New fields:
`iss?: string` (the form-urldecoded `iss` from the authorization callback — pass it
alongside `authorizationCode` for RFC 9207 validation), `skipIssuerMetadataValidation?:
boolean` (security-weakening opt-out of the RFC 8414 §3.3 issuer-echo check), and
`forceReauthorization?: boolean` (skip the refresh-token branch — set by the transport's
step-up path; hosts driving step-up themselves set it under the same condition).

#### Authorization-server mix-up defense (RFC 9207 / RFC 8414 §3.3) — action required

`transport.finishAuth()` and `auth()` now validate `iss` from the authorization callback
against the issuer recorded from validated AS metadata. A mismatched `iss` throws
`IssuerMismatchError` before the code is exchanged regardless of advertised support; a
**missing** `iss` throws only when the AS advertised
`authorization_response_iss_parameter_supported: true`.

Pass the callback URL's `URLSearchParams` so the SDK can read `iss` alongside `code`.
The SDK does **not** validate `state`; compare it yourself before calling `finishAuth`:

```typescript
const params = new URL(callbackUrl).searchParams;
if (params.get('state') !== expectedState) throw new Error('state mismatch');
await transport.finishAuth(params); // SDK reads `code` + `iss`
```

`transport.finishAuth(code, iss)` remains supported. Do **not** display `error` /
`error_description` / `error_uri` from a callback that failed `iss` validation — those
values are attacker-controlled in a mix-up attack.

`discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not
exactly match the URL it was fetched for (RFC 8414 §3.3). Set
`skipIssuerMetadataValidation: true` only as a temporary workaround for a known-misconfigured AS.

(`@modelcontextprotocol/server-legacy` AS implementers: `mcpAuthRouter()` now advertises
`authorization_response_iss_parameter_supported: true` by default and the bundled
authorize handler appends `iss` to every redirect issued via `res.redirect(...)` on the
supplied `res`. If you emit `Location` another way, append `params.issuer` as `iss`
yourself; if your callback is issued by an upstream AS you proxy to, set
`authorizationResponseIssParameterSupported = false` so the metadata does not over-claim.)

#### Dynamic Client Registration defaults (SEP-837, SEP-2207)

`auth()` now resolves `provider.clientMetadata` once via `resolveClientMetadata()` and
applies defaults to the DCR body: `grant_types` defaults to
`['authorization_code', 'refresh_token']`; `application_type` is derived from
`redirect_uris` (loopback / custom URI scheme → `'native'`, else `'web'`). A field you
set explicitly is never overwritten. The `grant_types` default applies to the DCR body
only — it does **not** drive the `offline_access` / `prompt=consent` augmentation on the
authorize request; statically-registered and CIMD clients that want that augmentation
must set `clientMetadata.grant_types` explicitly. Non-interactive providers (no
`redirectUrl`) get no `grant_types` default. Direct `registerClient()` callers (⚠
`@deprecated` — see [§Deprecated in v2](#deprecated-in-v2-sep-2577)) wanting the same
defaults pass `resolveClientMetadata(provider)` as `clientMetadata`. DCR
rejection now throws `RegistrationRejectedError` (carrying `status`, `body`,
`submittedMetadata`).

#### Token endpoint must use TLS (SEP-2207)

`exchangeAuthorization()`, `refreshAuthorization()`, `fetchToken()`, and the Cross-App
Access helpers throw `InsecureTokenEndpointError` when the token endpoint is not
`https:` (loopback `localhost` / `127.0.0.1` / `::1` exempt). `auth()` surfaces this on
every path including refresh — switch any plain-`http:` AS on a non-loopback host to
TLS; there is no opt-out. Storage confidentiality of `refresh_token` remains your
`saveTokens()` implementation's responsibility.

#### Scope step-up on `403 insufficient_scope` (SEP-2350)

`StreamableHTTPClientTransport` accepts `onInsufficientScope: 'reauthorize' | 'throw'`
(default `'reauthorize'`). On `'reauthorize'` the transport re-authorizes with the
**union** of the previously-requested and challenged scope (`computeScopeUnion`); when
that union strictly exceeds the current token's granted scope (`isStrictScopeSuperset`),
the SDK bypasses the refresh-token branch and forces a fresh authorization request. On
`'throw'` the transport raises `InsufficientScopeError` and does not re-authorize — set
this for `client_credentials` / m2m clients where re-authorization can't widen scope, or
to gate the consent prompt behind UX. Step-up retries are hard-capped per send
(`maxStepUpRetries`, default 1). With a non-OAuth [`AuthProvider`](#authprovider--non-oauth-bearer-auth-and-the-widened-authprovider-option),
a `403 insufficient_scope` now throws `InsufficientScopeError` instead of the previous
`SdkHttpError(ClientHttpNotImplemented)`. The GET listen-stream open path applies the
same handling as the POST send path.

#### Credentials bound to the issuing authorization server (SEP-2352)

`auth()` stamps an `issuer` field onto every value it passes to `saveTokens()` /
`saveClientInformation()` and threads `{ issuer }` as the `ctx` argument to those
methods plus `tokens()` / `clientInformation()`. On read, a stored value whose `issuer`
names a different AS is treated as `undefined` and the flow re-registers / re-authorizes.
**Round-trip the stored object verbatim and you're protected** — single-slot storage
works. To hold credentials for several authorization servers at once, key your storage
on `ctx.issuer` (treat **`ctx === undefined` as "return the most-recently-saved token
set"** — the transport's per-request `Authorization: Bearer` read calls `tokens()` with
no `ctx`). New TypeScript-only aliases `StoredOAuthTokens` / `StoredOAuthClientInformation`
add an optional `issuer?: string` field on top of the wire types.

`OAuthClientProvider.saveAuthorizationServerUrl()` / `authorizationServerUrl()` are
`@deprecated` (still written for back-compat, never read by the SDK). The bundled
`ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`, and
`CrossAppAccessProvider` gain `expectedIssuer?: string` and no longer define
`saveClientInformation()`. Implement `discoveryState()` / `saveDiscoveryState()` so the
callback leg can verify it is exchanging the code at the same AS the redirect targeted;
without it the SDK `console.warn`s once per callback (`discoveryState` must persist with
the same durability as `codeVerifier`).

#### Conformance obligations for `OAuthClientProvider` implementers

The SDK enforces every authorization MUST that lands in SDK code. The following live in
**your** implementation and the SDK structurally cannot enforce them:

- **Round-trip the `issuer` stamp** on persisted credentials (SEP-2352). Persist the
  value verbatim from `saveTokens` / `saveClientInformation` and return it verbatim.
- **Pass `expectedIssuer`** when constructing static-credential providers (SEP-2352).
- **Keep refresh tokens confidential in storage** (SEP-2207) — OS keychain or
  encrypted-at-rest store, never `localStorage` / plain files / logs.
- **Extract `iss` from the callback URL** and pass it to `finishAuth` (SEP-2468); when
  `IssuerMismatchError` is thrown, do not render the callback's `error*` values.
- **Set `application_type` correctly** when overriding the heuristic (SEP-837).
- **Track cross-request step-up failures yourself** (SEP-2350) — `maxStepUpRetries` is
  per request; per-session backoff is host state.
- **Resource-server operators: do not advertise `offline_access`** in `WWW-Authenticate`
  `scope` or PRM `scopes_supported` (SEP-2207).

### Types & schemas

#### Zod `*Schema` constants moved to `@modelcontextprotocol/core`

The Zod schemas (`CallToolResultSchema`, `ListToolsResultSchema`, …) that v1 exported
from `types.js` now live in a separate **`@modelcontextprotocol/core`** package. Neither
`@modelcontextprotocol/client` nor `@modelcontextprotocol/server` re-exports them — both
packages stay Zod-free in their public surface.

The v1→v2 change is just an import-path swap — `.parse()` / `.safeParse()` keep working
unchanged:

```typescript
// v1
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
if (CallToolResultSchema.safeParse(value).success) { ... }

// v2 — same Zod schema, new package
import { CallToolResultSchema } from '@modelcontextprotocol/core';
if (CallToolResultSchema.safeParse(value).success) { ... }
```

`@modelcontextprotocol/core` is the canonical home for the spec's Zod schema constants
(and the OAuth/OpenID metadata schemas). It is runtime-neutral (its only dependency is
`zod`) and is **not** required by `client` / `server` — install it only if you import the
raw schemas directly.

If you would rather keep your project Zod-free, the **`isSpecType` / `specTypeSchemas`**
alternatives are exported from `@modelcontextprotocol/client` and `…/server`:

```typescript
import { isSpecType, specTypeSchemas } from '@modelcontextprotocol/client';
if (isSpecType.CallToolResult(value)) { ... }
const blocks = mixed.filter(isSpecType.ContentBlock);
const result = specTypeSchemas.CallToolResult['~standard'].validate(value);
```

`isSpecType` and `specTypeSchemas` are keyed by `SpecTypeName` — a literal union of
every named type in the MCP spec — so you get autocomplete and a compile error on typos.
`specTypeSchemas.X` is a `StandardSchemaV1Sync<In, Out>` (`validate()` is synchronous).
The pre-existing `isCallToolResult(value)` guard still works.

**`specTypeSchemas.X` is `StandardSchemaV1`, not `ZodType`.** Zod-specific composition
— `.extend()`, `.pick()`, `.omit()`, `.merge()`, `.shape`, `.passthrough()`,
`.parseAsync()` — does **not** compile on a `specTypeSchemas` entry; reach for the real
Zod schema from `@modelcontextprotocol/core` when you need to derive a tolerant variant
of a spec schema (e.g.
`ListToolsResultSchema.extend({ tools: ToolSchema.omit({ outputSchema: true }).array() })`).
The Zod-specific `AnySchema` / `SchemaOutput` types from `…/zod-compat.js` are removed —
replace with `StandardSchemaV1` / `StandardSchemaV1.InferOutput<T>` (the codemod's
removal message says the same).

The role-aggregate unions (`ClientRequest`, `ServerResult`, `ServerRequest`,
`ClientResult`, `ClientNotification`, `ServerNotification`) and the typed-method maps
(`RequestMethod`, `RequestTypeMap`, `ResultTypeMap`, `NotificationTypeMap`) no longer
include task vocabulary; the deprecated `Task*` types remain importable on their own.

#### Removed type aliases

| Removed | Replacement |
| --- | --- |
| `JSONRPCError` | `JSONRPCErrorResponse` |
| `JSONRPCErrorSchema` | `JSONRPCErrorResponseSchema` |
| `isJSONRPCError` | `isJSONRPCErrorResponse` |
| `isJSONRPCResponse` (deprecated in v1) | `isJSONRPCResultResponse` ² |
| `ResourceReference` / `ResourceReferenceSchema` | `ResourceTemplateReference` / `ResourceTemplateReferenceSchema` |
| `IsomorphicHeaders` | Web Standard `Headers` |
| `RequestHandlerExtra` | `ServerContext` / `ClientContext` / `BaseContext` |
| `ResourceTemplate` (the spec wire **type** from `sdk/types.js`) | `ResourceTemplateType` ³ |

² v2 introduces a **new** `isJSONRPCResponse` with corrected semantics — it matches
**both** result and error responses. v1's `isJSONRPCResponse` only matched results. To
preserve v1 behavior, rename to `isJSONRPCResultResponse` (the codemod does this).

³ The `ResourceTemplate` URI-template helper **class** (from `sdk/server/mcp.js`) is
**unchanged** — keep `new ResourceTemplate(...)` as-is. Only the like-named spec wire
type from `types.js` was renamed to `ResourceTemplateType` to resolve the v1 collision;
the codemod scopes the rename to imports from `sdk/types.js` only.

All other symbols from `@modelcontextprotocol/sdk/types.js` retain their original
names — import the TypeScript types, error classes, enums, and type guards from
`@modelcontextprotocol/client` or `@modelcontextprotocol/server`, and the Zod
`*Schema` constants from `@modelcontextprotocol/core`.

#### JSON Schema 2020-12 posture (SEP-1613, SEP-2106)

The default validator supports **JSON Schema 2020-12 only**. On Node it is now `Ajv2020`
instead of draft-07 `Ajv`; the Cloudflare Workers default was already 2020-12. Schemas
declaring a different `$schema` are rejected with `Error("…unsupported dialect…")`.

`CallToolResult.structuredContent` is widened from `{ [k: string]: unknown }` to
`unknown` (SEP-2106 lifts the `type:"object"` root restriction). The presence check is
`!== undefined`, not falsy (`null` / `0` / `false` / `""` are legal values now). External
`$ref` is not dereferenced (unchanged from v1; Ajv throws `MissingRefError` at compile,
surfaced per-tool on `callTool`).

| v1 pattern | Mechanical fix |
| --- | --- |
| `result.structuredContent.<key>` / `result.structuredContent?.<k>` | narrow first: `const sc = result.structuredContent; if (typeof sc === 'object' && sc !== null && '<k>' in sc) { sc.<k> }` |
| `if (!result.structuredContent)` | `if (result.structuredContent === undefined)` |
| relying on default `Ajv` being draft-07 | `new AjvJsonSchemaValidator(new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }))` (import `Ajv`, `addFormats`, `AjvJsonSchemaValidator` from `…/validators/ajv`) |
| draft-07 idioms via `fromJsonSchema(schema)` | `fromJsonSchema(schema, new AjvJsonSchemaValidator(ajv))` — the `McpServer`/`Client` `jsonSchemaValidator` option does **not** reach `fromJsonSchema`-authored schemas |
| `outputSchema` / `inputSchema` with absolute-URI `$ref` | inline under `$defs` and reference with `#/$defs/Name` |

A tool may now register an `outputSchema` whose root is `type:"array"`, `type:"string"`,
etc.; toward 2025-era clients the codec wraps it in a `{result:…}` envelope, and toward
every era a non-object `structuredContent` with no `text` block of its own gets a
`JSON.stringify(...)` `text` block auto-appended. See [support-2026-07-28.md › Per-era wire codecs](./support-2026-07-28.md#per-era-wire-codecs) for how the codec applies these per era.

### Behavioral changes

These are runtime-behavior changes that may affect tests and assertions; no source
rewrite required unless noted.

#### Error-shape changes (every era)

- **Unknown / disabled tool calls now reject** with `ProtocolError(-32602 InvalidParams)`
  instead of resolving `CallToolResult{isError: true}`. v1 callers that checked
  `result.isError` for an unknown tool will get an unhandled rejection — catch the
  rejected promise instead.
- **In-flight request handlers are aborted on transport close** — `ctx.mcpReq.signal`
  fires (v1 let them run to completion). `InMemoryTransport.close()` no longer
  double-fires `onclose` on the initiating side.
- **`Protocol.request()` with an already-aborted signal** rejects with
  `SdkError(SdkErrorCode.RequestTimeout, reason)` instead of throwing the raw
  `signal.reason`, matching the in-flight-abort path.
- **OAuth discovery (`discoverOAuthProtectedResourceMetadata` / `discoverOAuthMetadata`,
  transitively `auth()`) throws on fetch `TypeError`** (DNS failure, `ECONNREFUSED`,
  invalid URL) in Node and Cloudflare Workers instead of swallowing it as a CORS miss
  → `undefined`. The CORS-swallow remains browser-only.

#### stdio transport

- A configurable `maxBufferSize` (default **10 MB**) caps the stdio read buffer. A
  single message that would push the buffer past the limit emits `onerror` and
  **closes the connection** (v1 buffered unbounded). Configure via
  `new StdioClientTransport({ ..., maxBufferSize })` /
  `new StdioServerTransport(stdin, stdout, { maxBufferSize })`.
- `ReadBuffer.readMessage()` now **silently skips non-JSON stdout lines** instead of
  throwing `SyntaxError` → `onerror`. Hot-reload tools (tsx, nodemon) that write debug
  output to stdout no longer break the transport. Lines that parse as JSON but fail
  JSON-RPC schema validation still throw.
- `StdioClientTransport` always sets `windowsHide: true` when spawning the server
  process on Windows (previously Electron-only). Prevents stray console windows in
  non-Electron Windows hosts.

#### Client list methods

- `listPrompts()`, `listResources()`, `listResourceTemplates()`, `listTools()` return
  **empty results** when the server didn't advertise the corresponding capability,
  instead of sending the request. Set `enforceStrictCapabilities: true` in `ClientOptions`
  to restore the v1 throw.
- Called **without a `cursor`**, the same methods now **auto-aggregate every page** and
  return `nextCursor: undefined`. Passing `{ cursor }` still fetches one page. Manual
  pagination loops keep working (the first iteration returns everything); replace them
  with the bare no-arg call. The walk is capped at `ClientOptions.listMaxPages` (default
  64); overrun throws `SdkError(ListPaginationExceeded)`.
- Output-schema validator compilation is now **lazy** — validators compile on the first
  `callTool()` against the cached `tools/list` entry, not eagerly inside `listTools()`.
  In v1, `listTools()` threw on an uncompilable `outputSchema`; now `listTools()`
  succeeds and the compile failure surfaces when `callTool()` is invoked on the affected
  tool, as `ProtocolError(InvalidParams, "Tool 'X' has an invalid outputSchema: …")`,
  before the request is sent. Validation is never silently skipped.
- On a 2026-07-28 connection the cacheable verbs honour the server-stamped `ttlMs` /
  `cacheScope` (SEP-2549) and may return a still-fresh cached entry without a round
  trip. Per-call override: `{ cacheMode: 'refresh' | 'bypass' }`. New `ClientOptions`:
  `cachePartition`, `defaultCacheTtlMs`. `ResponseCacheStore` gained `delete(key)`;
  `InMemoryResponseCacheStore` is now bounded (`{ maxEntries }`, default 512).

#### Server (Streamable HTTP transport)

- Resumability behavior (SSE priming events, `closeSSE` / `closeStandaloneSSE`
  callbacks) is only enabled for protocol versions in the transport's supported-versions
  list that are `>= 2025-11-25`. Unknown future version strings in an `initialize`
  request body no longer enable it.
- Session-ID mismatch still responds `404` with JSON-RPC `-32001` (`Session not found`),
  unchanged from v1. This `-32001` is an SDK convention, not spec-assigned; client code
  should key off the HTTP `404` status, not `-32001`.

#### Server (deprecated accessors and app-factory Origin validation)

- `Server.getClientCapabilities()`, `getClientVersion()`, `getNegotiatedProtocolVersion()`
  are `@deprecated` but functional. On 2026-07-28 requests, prefer `ctx.mcpReq.envelope`.
- `createMcpExpressApp()` / `createMcpHonoApp()` / `createMcpFastifyApp()` with a
  localhost-class `host` now also validate the `Origin` header by default. Browser-served
  clients on a non-localhost origin need `allowedOrigins: [...]` (replaces the default
  localhost allowlist; validation cannot be disabled for localhost binds). Requests
  without an `Origin` header are unaffected; a present `Origin` that cannot be parsed
  — including the opaque **`Origin: null`** sent by sandboxed iframes, `file://` pages,
  and cross-origin redirects — is **rejected with 403** and cannot be allowlisted via
  `allowedOrigins`. Framework-agnostic helpers
  (`validateOriginHeader`, `localhostAllowedOrigins`, `originValidationResponse`) are in
  `@modelcontextprotocol/server`; `@modelcontextprotocol/node` ships
  `hostHeaderValidation` / `originValidation` request guards for plain `node:http`.

#### Server (McpServer / Streamable HTTP behavior)

- **Eager capability-handler install.** `McpServer` now installs list/read/call handlers
  for every primitive capability declared in `ServerOptions.capabilities`, even with
  zero registrations. `new McpServer(info, { capabilities: { tools: {} } })` with no
  registered tools answers `tools/list` with `{ tools: [] }` instead of `-32601 Method
  not found`. Low-level `Server` users remain responsible for registering handlers for
  declared capabilities.
- **`WebStandardStreamableHTTPServerTransport` store-first `eventStore` semantics.**
  Request-related events emitted after `closeSSE()` — and the final response when no
  per-request stream is connected — are now persisted to the configured `eventStore` for
  replay (v1 dropped them / threw `"No connection established"`). Without an
  `eventStore`, the same condition surfaces via `onerror` and the request id is retired.
- **`registerResource` reserves the `cacheHint` config key.** It is validated
  (`RangeError` on invalid values) and stripped from the resource's list metadata; v1
  passed it through verbatim as ordinary metadata. Untyped callers that previously
  smuggled a `cacheHint` key through resource metadata should rename it.

#### `ctx.mcpReq.log()` is request-related on every era

`ctx.mcpReq.log()` now emits its `notifications/message` request-related (it rides the
in-flight exchange like progress) on every era. On a 2025-era sessionful Streamable HTTP
transport this moves handler-emitted logs from the standalone GET stream onto the
per-request POST response stream — a spec-conformance correction. The session-scoped
`logging/setLevel` filter applies as before on 2025-era connections. (On 2026-07-28
requests, the per-request `_meta.logLevel` envelope key is the filter — see
[support-2026-07-28.md](./support-2026-07-28.md#serving-the-2026-07-28-revision).)

#### Wire tightening (every era)

- **`CallToolResult.content` is required at the wire boundary.** The `content.default([])`
  affordance was removed. Tool handlers MUST include `content` (the TypeScript surface
  always required it; `content: []` is fine). A handler result without it is rejected
  with `-32602`.
- **Custom (3-arg) handlers receive `_meta`.** `setRequestHandler(method, {params}, handler)`
  used to delete `params._meta` before validation; it now passes `_meta` through (minus
  the reserved `io.modelcontextprotocol/*` envelope keys). If your params schema is
  strict, add an optional `_meta` member.
- **`specTypeSchemas` validate the neutral model.** Result entries no longer accept
  `resultType`; the validators for the 2025-only task message types and
  `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed accordingly).
- **Sampling `hasTools` discriminant** now keys on `tools || toolChoice` (previously
  `tools` only) when selecting the with-tools `CreateMessageResult` variant, on every
  era.

#### Experimental tasks interception removed

The 2025-11 task side-channel through `Protocol` is removed (was always `@experimental`).
No mechanical migration; remove usages. Gone: `ProtocolOptions.tasks`,
`protocol.taskManager`, `RequestOptions.task` / `relatedTask`, `BaseContext.task`,
`assertTaskCapability` / `assertTaskHandlerCapability`, `*.experimental.tasks.*`
accessors and `Experimental{Client,Server,McpServer}Tasks`, `requestStream` /
`callToolStream` / `createMessageStream` / `elicitInputStream` and the `ResponseMessage`
types they yielded, `registerToolTask`, `ToolTaskHandler`, `TaskRequestHandler`,
`CreateTaskRequestHandler`, `TaskMessageQueue`, `InMemoryTaskMessageQueue`,
`BaseQueuedMessage` / `Queued*`, `CreateTaskServerContext`, `TaskServerContext`,
`TaskToolExecution`, `TaskStore`, `InMemoryTaskStore`, `CreateTaskOptions`, `isTerminal`,
and the `new McpServer(info, { taskStore, taskMessageQueue })` constructor option keys
(the codemod emits an action-required diagnostic at each — remove the option).

The task **wire types** remain importable as `@deprecated` vocabulary for 2025-11-25
interop — see [support-2026-07-28.md](./support-2026-07-28.md#tasks-deprecated-wire-vocabulary).

#### Specification clarifications adopted (no SDK behavior change)

The 2026-07-28 specification revision includes a number of documentation-only
clarifications recorded here so an audit of the revision's changelog against this guide
is complete; nothing in this list requires code changes: per-operation timeout guidance
removal (`RequestOptions.timeout` / `DEFAULT_REQUEST_TIMEOUT_MSEC` unchanged); stdio
shutdown wording; transports-as-bindings reframe; `resources/read` wording (the
`file://` path-sanitization MUST is server-author guidance — your handler must reject
traversal / symlink escapes itself); `PromptMessage` resource links (already in
`ContentBlock`); completion `ref/resource` URI templates; pagination empty-string
cursors (already passed through verbatim); sampling host-requirement docs; elicitation
statefulness wording; cosmetic schema/JSDoc sweeps.

---

## Enhancements

### Automatic JSON Schema validator selection by runtime

The SDK auto-selects the validator: Node.js → AJV; Cloudflare Workers (workerd) →
`@cfworker/json-schema`. Cloudflare Workers users can remove explicit
`jsonSchemaValidator` configuration. You don't need to install `ajv`, `ajv-formats`, or
`@cfworker/json-schema` for the default path. To customize the built-in backend, import
the named class from the explicit subpath
(`@modelcontextprotocol/{client,server}/validators/ajv` or `…/cf-worker`) — importing
from a subpath means the corresponding peer dep must be in your `package.json`.

### `Client.connect(transport, { prior })` — zero-round-trip connect

Probe once, persist `client.getDiscoverResult()` (`JSON.stringify`), and feed it to
every worker as `client.connect(transport, { prior })` — 2026-07-28+ only. New exported
type `ConnectOptions` (extends `RequestOptions` with `prior?: DiscoverResult`).

### Serving the 2026-07-28 revision

`createMcpHandler`, `serveStdio`, `versionNegotiation`, multi-round-trip requests
(`requestState`), client cancellation via stream-close, `subscriptions/listen`,
`Mcp-Param-*` headers, and per-era wire codecs are covered in
**[support-2026-07-28.md](./support-2026-07-28.md)** — they are net-new in v2, not v1→v2
breaks.

---

## Unchanged APIs

The following are unchanged between v1 and v2 (only the import path changed):

- `Client` constructor and `connect`, `close`, and the typed verbs (`listTools`,
  `listPrompts`, `listResources`, `readResource`, …) — note `callTool()` and `request()`
  signatures changed (schema parameter dropped for spec methods).
- `McpServer` constructor, `server.connect(transport)`, `server.close()`.
- `StreamableHTTPClientTransport`, `SSEClientTransport` constructors and options.
- `StdioClientTransport` and `StdioServerTransport` — **import path moved** to the
  `./stdio` subpath and gained an optional `maxBufferSize` ([Imports & transports](#imports--transports)).
- All TypeScript **type** definitions from `types.ts` (except the aliases listed under
  [Removed type aliases](#removed-type-aliases)).
- Tool, prompt, and resource callback return types.

> The `Server` (low-level) constructor and **most** of its methods are unchanged, but
> `setRequestHandler` / `setNotificationHandler` and `request()` signatures changed
> ([Low-level protocol](#low-level-protocol--handler-context-ctx)). The Zod `*Schema`
> constants are **not** part of the unchanged surface — they are no longer public
> ([Types & schemas](#types--schemas)).

---

## Need help?

- The codemod's [`@mcp-codemod-error`](../../packages/codemod/README.md) markers point
  at every site it could not safely rewrite.
- The [FAQ](../faq.md) covers common v2 questions.
- Runnable [examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples)
  for every subsystem.
- Open an issue on [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/issues).
