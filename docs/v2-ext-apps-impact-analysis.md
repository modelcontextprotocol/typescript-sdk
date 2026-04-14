# MCP TypeScript SDK V2: Impact Analysis on ext-apps

## Context

This document analyzes how the V2 breaking changes in `@modelcontextprotocol/sdk` (now the
`@modelcontextprotocol/{core,client,server}` monorepo at `2.0.0-alpha.1`) affect
`@modelcontextprotocol/ext-apps` (`^1.29.0` dependency), and proposes a migration path.

It also covers the in-flight `fweinberger/protocol-concrete` branch, which makes `Protocol`
concrete and publicly exported with a `ProtocolSpec` generic — a change directly relevant to
ext-apps' architecture.

---

## 1. Executive Summary

ext-apps subclasses `Protocol` directly, passes Zod schema objects to handler registration,
and uses v1 import paths throughout. **Every one of these patterns breaks in V2.**

However, all _TypeScript types_ that ext-apps uses (`CallToolRequest`, `CallToolResult`,
`Implementation`, `Tool`, etc.) survive the transition unchanged — they are re-exported from
`@modelcontextprotocol/client` and `@modelcontextprotocol/server`.

The `protocol-concrete` branch is ext-apps-aware and provides a viable migration path: Protocol
becomes a concrete, publicly exported class with a `ProtocolSpec` generic that ext-apps can
use to declare its own method vocabulary. The old abstract-method stubs become no-op virtuals.

**Recommendation:** ext-apps should vendor the v1 `Protocol` class short-term, then migrate to
the `protocol-concrete` API once merged and stabilized. See §6 for details.

---

## 2. What V2 Changes

### 2.1 Package Split

| v1 | v2 |
|----|-----|
| `@modelcontextprotocol/sdk` (single package) | `@modelcontextprotocol/core` (private/internal) |
| | `@modelcontextprotocol/client` |
| | `@modelcontextprotocol/server` |

`@modelcontextprotocol/core` is `private: true` — end users must not import from it.
Both `client` and `server` re-export the public types from `core/public`.

### 2.2 Protocol Class Signature

| Version | Signature |
|---------|-----------|
| v1 (SDK 1.29) | `abstract class Protocol<SendRequestT, SendNotificationT, SendResultT>` |
| v2 main | `abstract class Protocol<ContextT extends BaseContext>` |
| v2 + protocol-concrete | `class Protocol<S extends ProtocolSpec = ProtocolSpec, ContextT extends BaseContext = BaseContext>` |

Key changes:
- **v1 → v2 main**: Three generic type params (request/notification/result unions) collapse to one
  (`ContextT`). The SDK now routes by method string internally, not by type-level discrimination.
- **v2 main → protocol-concrete**: `abstract` → concrete. The class is now directly instantiable
  and publicly exported. A new `ProtocolSpec` generic allows typed method vocabularies.

### 2.3 `setRequestHandler` / `setNotificationHandler`

| v1 | v2 |
|----|-----|
| `setRequestHandler(CallToolRequestSchema, handler)` | `setRequestHandler('tools/call', handler)` |
| `setNotificationHandler(LoggingMessageNotificationSchema, handler)` | `setNotificationHandler('notifications/message', handler)` |

Schema objects like `CallToolRequestSchema` are **no longer passed** to these methods.
Instead, a method string is used and the SDK internally resolves the correct schema.

**Type safety is preserved** for standard MCP methods — `M` narrows to a string literal
that indexes `RequestTypeMap`/`NotificationTypeMap`, so handler params/return are fully typed:
```typescript
// TypeScript infers: request is CallToolRequest, return must be CallToolResult
server.setRequestHandler('tools/call', async (request, ctx) => { ... });
```

For **custom (non-spec) methods** like ext-apps' `ui/*`, the untyped string fallback gives
`Record<string, unknown>` params. To get type safety on custom methods, use the
protocol-concrete branch's **3-arg overload** with a `ProtocolSpec` generic:
```typescript
// With ProtocolSpec, params/result are typed from the spec:
protocol.setRequestHandler('ui/initialize', paramsSchema, handler)
```

### 2.4 `Protocol.request()` / `Client.callTool()`

| v1 | v2 |
|----|-----|
| `client.request({method, params}, ResultSchema)` | `client.request({method, params})` |
| `client.callTool(params, CompatibilityCallToolResultSchema)` | `client.callTool(params)` |

Result schema argument removed. The SDK resolves it from the method name internally.

The protocol-concrete branch adds a string overload for custom methods:
```typescript
protocol.request('ui/initialize', params, ResultSchema, options)
```

### 2.5 Schema Objects No Longer Publicly Exported

In v1, all Zod schema objects (`CallToolRequestSchema`, `ListToolsRequestSchema`,
`ReadResourceResultSchema`, etc.) were exported from `@modelcontextprotocol/sdk/types.js`.

In v2, they are **internal to `@modelcontextprotocol/core`** and not part of the public API.

Replacements for runtime validation:
- `isCallToolResult(value)` — type guard (public)
- `isJSONRPCRequest(value)` — type guard (public)
- `isInitializeRequest(value)` — type guard (public)
- etc.

### 2.6 Abstract Methods → No-op Virtuals

Protocol's five abstract capability-check methods become no-op defaults:

```typescript
// v1: must implement these stubs
protected abstract assertCapabilityForMethod(method: RequestMethod): void;
protected abstract assertNotificationCapability(method: NotificationMethod): void;
protected abstract assertRequestHandlerCapability(method: string): void;
protected abstract assertTaskCapability(method: string): void;
protected abstract assertTaskHandlerCapability(method: string): void;
protected abstract buildContext(ctx, transportInfo?): ContextT;

// v2 (protocol-concrete): optional overrides
protected assertCapabilityForMethod(_method: string): void {}
protected buildContext(ctx: BaseContext, _transportInfo?: MessageExtraInfo): ContextT {
    return ctx as ContextT;
}
```

### 2.7 Context Types

| v1 | v2 |
|----|-----|
| `RequestHandlerExtra` (flat) | `ServerContext` / `ClientContext` (structured) |
| `extra.signal` | `ctx.mcpReq.signal` |
| `extra.sendRequest(...)` | `ctx.mcpReq.send(...)` |
| `extra.authInfo` | `ctx.http?.authInfo` |
| `extra.sessionId` | `ctx.sessionId` |

### 2.8 Error Hierarchy

| v1 | v2 |
|----|-----|
| `McpError` | `ProtocolError` |
| `ErrorCode` | `ProtocolErrorCode` |
| `ErrorCode.RequestTimeout` | `SdkErrorCode.RequestTimeout` |

### 2.9 Import Paths

All `@modelcontextprotocol/sdk/*` deep import paths are gone. Examples:

| v1 | v2 |
|----|-----|
| `@modelcontextprotocol/sdk/shared/protocol.js` | Not public; use `@modelcontextprotocol/client` or `server` |
| `@modelcontextprotocol/sdk/types.js` | Types from `@modelcontextprotocol/client` or `server` |
| `@modelcontextprotocol/sdk/client/index.js` | `@modelcontextprotocol/client` |
| `@modelcontextprotocol/sdk/server/mcp.js` | `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/server/stdio.js` | `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/inMemory.js` | `@modelcontextprotocol/core` (test-only) |
| `@modelcontextprotocol/sdk/shared/transport.js` | Types from `@modelcontextprotocol/client` or `server` |

---

## 3. How ext-apps Uses the SDK Today (v1)

### 3.1 Class Hierarchy

```
Protocol<SendRequestT, SendNotificationT, SendResultT>  (SDK v1)
└── ProtocolWithEvents<..., EventMap>                    (ext-apps/src/events.ts)
    ├── App                                               (ext-apps/src/app.ts)
    └── AppBridge                                         (ext-apps/src/app-bridge.ts)
```

`ProtocolWithEvents` adds DOM-style event handling on top of Protocol:
- `addEventListener` / `removeEventListener` (multi-listener)
- `on*` singular handler setters (replace semantics)
- Double-set protection on `setRequestHandler`/`setNotificationHandler`
- `replaceRequestHandler` for intentional overwrites

### 3.2 Schema Objects Used at Runtime

ext-apps passes these SDK Zod schemas to `setRequestHandler()` / `setNotificationHandler()`:

**As `setRequestHandler` first arg:**
- `PingRequestSchema` — in App constructor, AppBridge constructor
- `CallToolRequestSchema` — in App `set oncalltool`
- `ListToolsRequestSchema` — in App `set onlisttools`
- `ListResourcesRequestSchema` — in AppBridge `set onlistresources`
- `ListResourceTemplatesRequestSchema` — in AppBridge `set onlistresourcetemplates`
- `ReadResourceRequestSchema` — in AppBridge `set onreadresource`
- `ListPromptsRequestSchema` — in AppBridge `set onlistprompts`
- Various `McpUi*RequestSchema` (ext-apps' own schemas)

**As `setNotificationHandler` first arg (via Client):**
- `ToolListChangedNotificationSchema` — in AppBridge.connect()
- `ResourceListChangedNotificationSchema` — in AppBridge.connect()
- `PromptListChangedNotificationSchema` — in AppBridge.connect()

**As `request()` second arg (result schema):**
- `CallToolResultSchema`, `ReadResourceResultSchema`, `ListResourcesResultSchema`,
  `ListResourceTemplatesResultSchema`, `ListPromptsResultSchema`, `ListToolsResultSchema`
- `EmptyResultSchema` — in App.updateModelContext()
- Various `McpUi*ResultSchema` (ext-apps' own schemas)

**Runtime Zod `.safeParse()`:**
- `JSONRPCMessageSchema.safeParse(event.data)` — in PostMessageTransport (one call site)

### 3.3 Types Used (Type-Only Imports)

These types are used throughout ext-apps and remain available in V2:
- `CallToolRequest`, `CallToolResult`, `ListToolsRequest`, `ListToolsResult`
- `ListResourcesRequest`, `ListResourcesResult`, `ReadResourceRequest`, `ReadResourceResult`
- `ListResourceTemplatesRequest`, `ListResourceTemplatesResult`
- `ListPromptsRequest`, `ListPromptsResult`
- `Implementation`, `Tool`, `ContentBlock`, `EmbeddedResource`, `ResourceLink`
- `LoggingMessageNotification`, `EmptyResult`, `PingRequest`, `ServerCapabilities`
- `JSONRPCMessage`, `MessageExtraInfo`, `RequestId`
- `Transport`, `TransportSendOptions`
- `ProtocolOptions`, `RequestOptions`

### 3.4 SDK Internal APIs Used

| Import | Source | Status in V2 |
|--------|--------|-------------|
| `Protocol` class | `sdk/shared/protocol.js` | Internal; exported in protocol-concrete branch |
| `ProtocolOptions` | `sdk/shared/protocol.js` | Re-exported via `client`/`server` |
| `RequestOptions` | `sdk/shared/protocol.js` | Re-exported via `client`/`server` |
| `InMemoryTransport` | `sdk/inMemory.js` | Internal; `@modelcontextprotocol/core` only |
| `AnySchema`, `ZodRawShapeCompat` | `sdk/server/zod-compat.js` | Internal |
| `McpServer` types | `sdk/server/mcp.js` | Re-exported via `@modelcontextprotocol/server` |

### 3.5 How `ProtocolWithEvents` Hooks Into Protocol

```typescript
// events.ts — the key coupling points:

// 1. Extends Protocol with 3 generic type params
export abstract class ProtocolWithEvents<
  SendRequestT extends Request,
  SendNotificationT extends Notification,
  SendResultT extends Result,
  EventMap extends Record<string, unknown>,
> extends Protocol<SendRequestT, SendNotificationT, SendResultT> {

// 2. Overrides setRequestHandler/setNotificationHandler as arrow-function fields
//    Uses Protocol<...>["setRequestHandler"] type indexing
override setRequestHandler: Protocol<
  SendRequestT, SendNotificationT, SendResultT
>["setRequestHandler"] = (schema, handler) => {
    this._assertMethodNotRegistered(schema, "setRequestHandler");
    super.setRequestHandler(schema, handler);
};

// 3. Calls super.setNotificationHandler(schema, handler) for event dispatch
super.setNotificationHandler(schema, (n) => {
    const params = (n as { params: EventMap[K] }).params;
    this.onEventDispatch(event, params);
    s.onHandler?.(params);
    for (const l of [...s.listeners]) l(params);
});

// 4. Uses schema.shape.method.value to extract method name from Zod schema
private _assertMethodNotRegistered(schema: unknown, via: string): void {
    const method = (schema as MethodSchema).shape.method.value;
    // ...
}
```

---

## 4. Breaking Change Impact Matrix

| Breaking change | ext-apps impact | Severity | Migration path |
|----------------|----------------|----------|---------------|
| Protocol generic signature (3→1→2 params) | `ProtocolWithEvents` extends old signature | **Critical** | Vendor v1 Protocol OR migrate to ProtocolSpec |
| `setRequestHandler(schema, handler)` → `setRequestHandler(method, handler)` | ~20 call sites in App, AppBridge, events.ts | **Critical** | Replace schema arg with method string |
| Schema objects removed from public API | ~15 distinct SDK schemas imported and used | **High** | Use method strings for handlers; vendor schemas for `request()` |
| `request(req, resultSchema)` → `request(req)` | ~10 call sites forwarding MCP requests | **High** | Drop result schema arg for spec methods; use 3-arg form for custom |
| Import paths changed | Every import in every file | **High** | Bulk find/replace |
| `RequestHandlerExtra` → `ServerContext`/`ClientContext` | Handler callback signatures in App, AppBridge | **Medium** | Update field access paths |
| `McpError` → `ProtocolError`/`SdkError` | Any error handling code | **Low** | Rename |
| `InMemoryTransport` path changed | Tests only | **Low** | Update import path |
| Abstract methods → no-op virtuals | App, AppBridge implement stubs | **Positive** | Can remove stubs (or keep as overrides) |

---

## 5. Can ext-apps Still Use `CallToolRequest` / `CallToolRequestSchema`?

### `CallToolRequest` (type) — ✅ YES

The TypeScript type `CallToolRequest` survives V2 unchanged. It is re-exported from both
`@modelcontextprotocol/client` and `@modelcontextprotocol/server`. All type-only imports
continue to work with a path change.

### `CallToolRequestSchema` (Zod schema object) — ❌ NO (not in public API)

The runtime Zod schema object `CallToolRequestSchema` is **no longer part of the public API**
in V2. It exists only in the internal `@modelcontextprotocol/core` barrel.

For **ext-apps' own schemas** that compose SDK schemas (e.g., `generated/schema.ts` uses
`CallToolResultSchema`, `ToolSchema`, `ContentBlockSchema` to build its own Zod types),
this is a problem — those SDK schemas are no longer importable.

**Migration options for schema objects:**

1. **For `setRequestHandler`/`setNotificationHandler`**: Replace schema with method string.
   ```typescript
   // v1
   this.setRequestHandler(CallToolRequestSchema, handler)
   // v2
   this.setRequestHandler('tools/call', handler)
   ```

2. **For `request()` calls**: Drop result schema arg (SDK resolves internally).
   ```typescript
   // v1
   this._client.request({ method: 'tools/call', params }, CallToolResultSchema)
   // v2
   this._client.request({ method: 'tools/call', params })
   ```

3. **For ext-apps' own Zod schema composition**: Either:
   - Import from `@modelcontextprotocol/core` (marked internal, but may be acceptable for
     a first-party extension)
   - Define standalone Zod schemas that replicate the needed shapes
   - Use `fromJsonSchema()` to derive schemas from JSON Schema

4. **For `JSONRPCMessageSchema.safeParse()`**: Use the `isJSONRPCRequest` / `isJSONRPCResponse`
   type guards, or import from `@modelcontextprotocol/core`.

---

## 6. Proposed Migration Strategy

### Option A: Vendor v1 Protocol (Short-Term)

ext-apps copies the v1 `Protocol` class into its own codebase, maintaining the existing
architecture while updating all other imports to v2 paths:

**Pros:**
- Minimal code churn in `events.ts`, `app.ts`, `app-bridge.ts`
- Can ship quickly
- Decouples from Protocol's internal evolution

**Cons:**
- Forks from upstream — must maintain vendored code
- Misses protocol-concrete improvements (custom method support, StandardSchema)
- Must still update import paths and schema usages

### Option B: Migrate to protocol-concrete API (Medium-Term)

Once the `protocol-concrete` branch merges, ext-apps can:

1. Change `ProtocolWithEvents` to extend `Protocol<AppSpec, BaseContext>` where `AppSpec`
   is a `ProtocolSpec` declaring ext-apps' custom methods
2. Use the 3-arg `setRequestHandler(method, paramsSchema, handler)` for custom methods
3. Use the 2-arg `setRequestHandler('tools/call', handler)` for standard MCP methods
4. Use the string-form `request('ui/initialize', params, resultSchema)` for custom requests

```typescript
// Example ProtocolSpec for ext-apps:
type AppSpec = {
    requests: {
        'ui/initialize': { params: McpUiInitializeParams; result: McpUiInitializeResult };
        'ui/open-link': { params: { url: string }; result: McpUiOpenLinkResult };
        'ui/message': { params: McpUiMessageParams; result: McpUiMessageResult };
        // ... other ui/* methods
    };
    notifications: {
        'ui/notifications/tool-input': { params: McpUiToolInputParams };
        'ui/notifications/size-changed': { params: McpUiSizeChangedParams };
        // ... other notification methods
    };
} satisfies ProtocolSpec;
```

**Pros:**
- Stays on supported public API
- Gets typed custom method support
- StandardSchema support (not just Zod)
- Protocol improvements flow downstream automatically

**Cons:**
- Significant refactor of `ProtocolWithEvents` and its callers
- Depends on protocol-concrete merging
- The `ProtocolWithEvents` event model (DOM-style `addEventListener`) sits on top of
  Protocol's single-handler model — the mapping layer needs rethinking

### Option C: Hybrid (Recommended)

1. **Immediately**: Update import paths, adopt v2 type names/error names
2. **Short-term**: Vendor v1 Protocol for the `ProtocolWithEvents` base class
3. **Medium-term**: Once protocol-concrete stabilizes, migrate to `Protocol<AppSpec>`
   and rewrite `ProtocolWithEvents` to use the 3-arg custom-method overloads
4. **Long-term**: Evaluate whether `ProtocolWithEvents` should be upstreamed as a
   first-class SDK pattern

### Migration Checklist

- [ ] Update all `@modelcontextprotocol/sdk/*` imports to v2 package paths
- [ ] Replace `setRequestHandler(Schema, handler)` → `setRequestHandler(method, handler)` for
      standard MCP methods
- [ ] Replace `setNotificationHandler(Schema, handler)` → `setNotificationHandler(method, handler)`
      for standard MCP methods
- [ ] Drop result schema args from `request()` / `callTool()` calls for standard MCP methods
- [ ] Handle custom (ext-apps-specific) methods:
  - Extract method strings from `McpUi*RequestSchema.shape.method.value`
  - Use 3-arg overloads (protocol-concrete) or method strings
- [ ] Update `ProtocolWithEvents` to match new Protocol generic signature
- [ ] Update `_assertMethodNotRegistered` to extract method name without Zod `.shape` access
- [ ] Replace `JSONRPCMessageSchema.safeParse()` with type guards or vendored schema
- [ ] Update `generated/schema.ts` to not depend on SDK Zod schemas (or import from core)
- [ ] Replace `RequestHandlerExtra` with `BaseContext` in handler signatures
- [ ] Rename `McpError` → `ProtocolError`, `ErrorCode` → `ProtocolErrorCode`/`SdkErrorCode`
- [ ] Update `InMemoryTransport` import in tests
- [ ] Update `AnySchema`/`ZodRawShapeCompat` imports in `server/index.ts`

---

## 7. Type Safety Regression for Custom Method Handlers

In v1, `setRequestHandler(schema, handler)` was **protocol-agnostic** — the Zod schema
carried both the method discriminator and the full request type. Any Zod schema with
`{ method: z.literal('...') }` worked identically, whether it was `CallToolRequestSchema`
(MCP spec) or `McpUiInitializeRequestSchema` (ext-apps custom). The handler received
`z.infer<typeof schema>` regardless of provenance.

V2 **splits this into two paths**:

1. **Spec methods** (`M extends RequestMethod`): fully typed via `RequestTypeMap[M]`.
   Handler receives the full request object. Type-safe.
2. **Custom methods** (string fallback): 3-arg form `(method, paramsSchema, handler)`.
   Handler receives only validated `params` (not the full request envelope), and the
   return type is `Result` (untyped) unless a `ProtocolSpec` generic is supplied.

This means ext-apps' current pattern:
```typescript
// v1: one generic, works for any schema, fully typed
this.replaceRequestHandler(McpUiOpenLinkRequestSchema, (request, extra) => {
    // request is McpUiOpenLinkRequest (full envelope)
    return this._onopenlink(request.params, extra);
});
```

Becomes either:
```typescript
// v2 untyped fallback: params is Record<string, unknown>
this.setRequestHandler('ui/open-link', McpUiOpenLinkParamsSchema, (params, ctx) => {
    return this._onopenlink(params, ctx); // params typed from schema only
});
```

Or (with `ProtocolSpec`):
```typescript
// v2 + ProtocolSpec: fully typed from the spec
this.setRequestHandler('ui/open-link', McpUiOpenLinkParamsSchema, (params, ctx) => {
    return this._onopenlink(params, ctx); // params typed from AppSpec
});
```

The **handler shape also changes**: v1 handlers receive the full JSON-RPC request object
(`{ method, params }`), v2 custom handlers receive only the validated `params` (with `_meta`
stripped). This affects ext-apps' `ProtocolWithEvents._assertMethodNotRegistered()` which
currently accesses `schema.shape.method.value` to extract the method name — that Zod
introspection no longer works when the first arg is a string.

**Recommendation**: The `ProtocolSpec` path restores full type safety but requires ext-apps
to declare its method vocabulary up front. The v1 approach of "pass any schema, get types
for free" was more ergonomic for extension protocols. Consider whether the SDK should
preserve a schema-based overload alongside the string-based one.

---

## 8. Package Dependency Model

Both `@modelcontextprotocol/client` and `@modelcontextprotocol/server` depend on
`@modelcontextprotocol/core` (`"workspace:^"`) and re-export its public types via
`export * from '@modelcontextprotocol/core/public'`. The types are **not duplicated** u2014
`core` is a single copy at install time. `CallToolRequest` imported from either `client`
or `server` has the same type identity.

ext-apps already uses both `Client` (from `client`) and `McpServer` (from `server`),
so it would depend on two packages instead of one u2014 but this is a cosmetic change, not
a real cost. The types come along for free from either package.

`@modelcontextprotocol/core` is `private: true` and must not be depended on directly
by consumers. However, ext-apps' `generated/schema.ts` composes SDK Zod schemas
(`CallToolResultSchema`, `ToolSchema`, etc.) which are only in `core`'s internal barrel.
This is the one case where ext-apps may need a blessed escape hatch or must vendor
those schemas.

---

## 9. Discussion Points for SDK Team

1. **Should `Protocol` be part of the public API?** The protocol-concrete branch exports it.
   ext-apps is the primary consumer outside the SDK itself. If Protocol stays internal,
   ext-apps must vendor it.

2. **Should some schema objects remain public?** ext-apps' `generated/schema.ts` composes
   SDK schemas (`CallToolResultSchema`, `ToolSchema`, `ContentBlockSchema`, etc.). If these
   are internal-only, ext-apps must duplicate them. Consider a `@modelcontextprotocol/schemas`
   package or re-exporting key schemas.

3. **Should the 3-arg `setRequestHandler(method, schema, handler)` be the blessed pattern
   for custom methods?** ext-apps currently uses ~10 custom `McpUi*` request/notification
   types. The protocol-concrete 3-arg overload is the cleanest migration path.

4. **`ProtocolWithEvents` pattern**: The DOM-style event system is useful for UI apps.
   Should the SDK provide a built-in event-emitter layer, or should ext-apps continue
   to layer it on top?

5. **`InMemoryTransport`**: Used in ext-apps tests. The protocol-concrete branch re-exports
   it from the public API — is this intentional?

---

## Appendix A: Complete Import Inventory (ext-apps → SDK)

### Types (survive V2 with path change)
```
CallToolRequest, CallToolResult, CallToolRequestParams
ListToolsRequest, ListToolsResult
ListResourcesRequest, ListResourcesResult
ListResourceTemplatesRequest, ListResourceTemplatesResult
ReadResourceRequest, ReadResourceResult
ListPromptsRequest, ListPromptsResult
Implementation, Tool, ToolAnnotations
ContentBlock, EmbeddedResource, ResourceLink
LoggingMessageNotification, EmptyResult, PingRequest
ServerCapabilities, ClientCapabilities
JSONRPCMessage, MessageExtraInfo, RequestId
Transport, TransportSendOptions
ProtocolOptions, RequestOptions
PromptListChangedNotification, ResourceListChangedNotification, ToolListChangedNotification
```

### Schema Objects (removed from public API in V2)
```
CallToolRequestSchema, CallToolResultSchema
ListToolsRequestSchema, ListToolsResultSchema
ListResourcesRequestSchema, ListResourcesResultSchema
ListResourceTemplatesRequestSchema, ListResourceTemplatesResultSchema
ReadResourceRequestSchema, ReadResourceResultSchema
ListPromptsRequestSchema, ListPromptsResultSchema
PingRequestSchema, EmptyResultSchema
LoggingMessageNotificationSchema
ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema
JSONRPCMessageSchema
ContentBlockSchema, EmbeddedResourceSchema, ResourceLinkSchema
ImplementationSchema, RequestIdSchema, ToolSchema
```

### Classes (import path changes)
```
Protocol              — sdk/shared/protocol.js → internal (or public via protocol-concrete)
Client                — sdk/client/index.js → @modelcontextprotocol/client
InMemoryTransport     — sdk/inMemory.js → @modelcontextprotocol/core (internal)
McpServer             — sdk/server/mcp.js → @modelcontextprotocol/server
StdioServerTransport  — sdk/server/stdio.js → @modelcontextprotocol/server
StreamableHTTPServerTransport — sdk/server/streamableHttp.js → @modelcontextprotocol/server
```

### Internal Utilities (no public equivalent)
```
AnySchema, ZodRawShapeCompat — sdk/server/zod-compat.js
createMcpExpressApp          — sdk/server/express.js → @modelcontextprotocol/express (middleware pkg)
```
