# Transport Flip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate handler registry, protocol version routing, and wire transport into three clean layers so the SDK supports both 2025-11 (stateful) and 2026-06 (stateless) protocol versions on a single server instance.

**Architecture:** Extract Protocol's handler maps into a shared `HandlerRegistry`. Build an abstract `McpVersionRouter` that classifies incoming messages by era and dispatches modern requests directly to McpServer while routing legacy requests through frozen Server/Protocol instances connected via a `BridgeTransport`. See `transport-flip-analysis.html` §2–§5 for the full design.

**Tech Stack:** TypeScript, Vitest, Zod v4, pnpm monorepo

**Reference:** `transport-flip-analysis.html` (in repo root) — the architecture document this plan implements.

---

## File Map

### New files

| File | Responsibility |
|------|----------------|
| `packages/core/src/shared/handler-registry.ts` | `HandlerRegistry<ContextT>` — typed Map wrapper for request and notification handlers |
| `packages/core/test/shared/handler-registry.test.ts` | Unit tests for HandlerRegistry |
| `packages/server/src/server/bridge-transport.ts` | `BridgeTransport` — in-memory Transport adapter for the legacy bridge |
| `packages/server/test/server/bridge-transport.test.ts` | Unit tests for BridgeTransport |
| `packages/server/src/server/version-router.ts` | `McpVersionRouter` abstract base — modern dispatch, legacy bridge, server/discover |
| `packages/server/src/server/http-version-router.ts` | `HttpVersionRouter` — HTTP classification, Tier 1 building blocks, Tier 2 convenience |
| `packages/server/src/server/stdio-version-router.ts` | `StdioVersionRouter` — stdio classification with connection-era locking |
| `packages/server/test/server/version-router.test.ts` | Tests for McpVersionRouter via a concrete test subclass |
| `packages/server/test/server/http-version-router.test.ts` | Tests for HttpVersionRouter |
| `packages/server/test/server/stdio-version-router.test.ts` | Tests for StdioVersionRouter |

### Modified files

| File | What changes |
|------|-------------|
| `packages/core/src/shared/protocol.ts` | Constructor accepts optional `HandlerRegistry`; six map accesses become registry method calls |
| `packages/core/src/index.ts` | Add `export * from './shared/handler-registry.js'` |
| `packages/core/src/exports/public/index.ts` | Export `HandlerRegistry` type for public API consumers |
| `packages/server/src/server/mcp.ts` | Create and own a `HandlerRegistry`; add `dispatch()` and `registry` getter; lazy init writes to registry instead of `this.server` |
| `packages/server/src/server/server.ts` | Constructor passes through `registry` option to Protocol super() |
| `packages/server/src/index.ts` | Export new router classes, BridgeTransport, HandlerRegistry re-export |

---

## Task 1: HandlerRegistry class

**Files:**
- Create: `packages/core/src/shared/handler-registry.ts`
- Create: `packages/core/test/shared/handler-registry.test.ts`

A minimal typed wrapper around two Maps. No protocol logic, no capability checks, no wrapping — just storage with get/set/delete/has.

- [ ] **Step 1: Write the tests**

```typescript
// packages/core/test/shared/handler-registry.test.ts
import { describe, it, expect } from 'vitest';
import type { JSONRPCNotification, JSONRPCRequest, Result } from '../../src/types/index.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import { HandlerRegistry } from '../../src/shared/handler-registry.js';

describe('HandlerRegistry', () => {
    describe('request handlers', () => {
        it('stores and retrieves a request handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            expect(registry.getRequestHandler('tools/call')).toBe(handler);
        });

        it('returns undefined for unregistered method', () => {
            const registry = new HandlerRegistry<BaseContext>();
            expect(registry.getRequestHandler('tools/call')).toBeUndefined();
        });

        it('overwrites a handler for the same method', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler1 = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            const handler2 = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({ changed: true });
            registry.setRequestHandler('tools/call', handler1);
            registry.setRequestHandler('tools/call', handler2);
            expect(registry.getRequestHandler('tools/call')).toBe(handler2);
        });

        it('removes a handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            registry.removeRequestHandler('tools/call');
            expect(registry.getRequestHandler('tools/call')).toBeUndefined();
        });

        it('reports whether a handler exists', () => {
            const registry = new HandlerRegistry<BaseContext>();
            expect(registry.hasRequestHandler('tools/call')).toBe(false);
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/call', handler);
            expect(registry.hasRequestHandler('tools/call')).toBe(true);
        });
    });

    describe('notification handlers', () => {
        it('stores and retrieves a notification handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_n: JSONRPCNotification): Promise<void> => {};
            registry.setNotificationHandler('notifications/cancelled', handler);
            expect(registry.getNotificationHandler('notifications/cancelled')).toBe(handler);
        });

        it('returns undefined for unregistered notification', () => {
            const registry = new HandlerRegistry<BaseContext>();
            expect(registry.getNotificationHandler('notifications/cancelled')).toBeUndefined();
        });

        it('removes a notification handler', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_n: JSONRPCNotification): Promise<void> => {};
            registry.setNotificationHandler('notifications/cancelled', handler);
            registry.removeNotificationHandler('notifications/cancelled');
            expect(registry.getNotificationHandler('notifications/cancelled')).toBeUndefined();
        });
    });

    describe('sharing', () => {
        it('two consumers see the same handler when sharing a registry', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});
            registry.setRequestHandler('tools/list', handler);

            // Simulate two consumers reading from the same registry
            const fromConsumer1 = registry.getRequestHandler('tools/list');
            const fromConsumer2 = registry.getRequestHandler('tools/list');
            expect(fromConsumer1).toBe(fromConsumer2);
            expect(fromConsumer1).toBe(handler);
        });

        it('mutations by one consumer are visible to another', () => {
            const registry = new HandlerRegistry<BaseContext>();
            const handler = async (_req: JSONRPCRequest, _ctx: BaseContext): Promise<Result> => ({});

            // Consumer 1 registers
            registry.setRequestHandler('tools/call', handler);

            // Consumer 2 sees it
            expect(registry.getRequestHandler('tools/call')).toBe(handler);

            // Consumer 1 removes
            registry.removeRequestHandler('tools/call');

            // Consumer 2 sees removal
            expect(registry.getRequestHandler('tools/call')).toBeUndefined();
        });
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/core test -- test/shared/handler-registry.test.ts`
Expected: FAIL — cannot resolve `handler-registry.js`

- [ ] **Step 3: Implement HandlerRegistry**

```typescript
// packages/core/src/shared/handler-registry.ts
import type { JSONRPCNotification, JSONRPCRequest, Result } from '../types/index.js';
import type { BaseContext } from './protocol.js';

/**
 * Type of request handler functions stored in the registry.
 */
export type RequestHandlerFn<ContextT> = (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

/**
 * Type of notification handler functions stored in the registry.
 */
export type NotificationHandlerFn = (notification: JSONRPCNotification) => Promise<void>;

/**
 * Shared storage for request and notification handlers.
 *
 * Extracted from Protocol so that multiple consumers (modern dispatch path,
 * legacy Server/Protocol instances) can share the same set of handlers.
 * When not shared, Protocol creates its own internal registry automatically.
 */
export class HandlerRegistry<ContextT extends BaseContext = BaseContext> {
    private _requestHandlers = new Map<string, RequestHandlerFn<ContextT>>();
    private _notificationHandlers = new Map<string, NotificationHandlerFn>();

    getRequestHandler(method: string): RequestHandlerFn<ContextT> | undefined {
        return this._requestHandlers.get(method);
    }

    setRequestHandler(method: string, handler: RequestHandlerFn<ContextT>): void {
        this._requestHandlers.set(method, handler);
    }

    removeRequestHandler(method: string): void {
        this._requestHandlers.delete(method);
    }

    hasRequestHandler(method: string): boolean {
        return this._requestHandlers.has(method);
    }

    getNotificationHandler(method: string): NotificationHandlerFn | undefined {
        return this._notificationHandlers.get(method);
    }

    setNotificationHandler(method: string, handler: NotificationHandlerFn): void {
        this._notificationHandlers.set(method, handler);
    }

    removeNotificationHandler(method: string): void {
        this._notificationHandlers.delete(method);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/core test -- test/shared/handler-registry.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Export from core**

Add to `packages/core/src/index.ts`:
```typescript
export * from './shared/handler-registry.js';
```

Add to `packages/core/src/exports/public/index.ts` (with the other type exports):
```typescript
export { HandlerRegistry } from '../../shared/handler-registry.js';
export type { RequestHandlerFn, NotificationHandlerFn } from '../../shared/handler-registry.js';
```

- [ ] **Step 6: Verify full core test suite still passes**

Run: `pnpm --filter @modelcontextprotocol/core test`
Expected: All existing tests PASS

- [ ] **Step 7: Suggest commit**

```
feat(core): add HandlerRegistry class for shared handler storage

Extract typed Map wrappers for request and notification handlers
into a standalone class. This enables multiple consumers (modern
dispatch, legacy Server instances) to share the same handler set.
```

---

## Task 2: Protocol refactor to use HandlerRegistry

**Files:**
- Modify: `packages/core/src/shared/protocol.ts` (lines 61-95, 311-316, 350-356, 541-556, 1077-1109, 1129-1140, 1162-1197)

Six changes: add `registry?` to ProtocolOptions, replace two private Map fields with a registry reference, and redirect all reads/writes.

- [ ] **Step 1: Write a test that Protocol uses an external registry when provided**

Add to `packages/core/test/shared/protocol.test.ts`, inside the main `describe` block:

```typescript
describe('shared HandlerRegistry', () => {
    it('uses an externally-provided registry', async () => {
        const registry = new HandlerRegistry<BaseContext>();
        const protocol1 = new TestProtocolImpl({ registry });
        const protocol2 = new TestProtocolImpl({ registry });

        const handler = async () => ({});
        protocol1.setRequestHandler('tools/list', { params: z.object({}) }, handler);

        // protocol2 shares the registry, so it should see the handler
        // We verify by sending a tools/list request to protocol2 and getting a response
        const transport2 = new MockTransport();
        const sendSpy = vi.spyOn(transport2, 'send');
        await protocol2.connect(transport2);

        // Simulate incoming request
        transport2.onmessage!({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
        });

        // Wait for response
        await vi.waitFor(() => {
            expect(sendSpy).toHaveBeenCalledWith(
                expect.objectContaining({ id: 1, result: expect.anything() }),
                expect.anything()
            );
        });
    });

    it('creates its own registry when none provided', async () => {
        const protocol = new TestProtocolImpl();
        // Should work normally — no crash, handlers stored internally
        protocol.setRequestHandler('tools/list', { params: z.object({}) }, async () => ({}));
    });

    it('assertCanSetRequestHandler checks the shared registry', () => {
        const registry = new HandlerRegistry<BaseContext>();
        const protocol1 = new TestProtocolImpl({ registry });
        const protocol2 = new TestProtocolImpl({ registry });

        protocol1.setRequestHandler('tools/list', { params: z.object({}) }, async () => ({}));

        // protocol2 should see the handler exists
        expect(() => protocol2.assertCanSetRequestHandler('tools/list')).toThrow(
            'A request handler for tools/list already exists'
        );
    });
});
```

Also add this import at the top of the test file:
```typescript
import { HandlerRegistry } from '../../src/shared/handler-registry.js';
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/core test -- test/shared/protocol.test.ts -t "shared HandlerRegistry"`
Expected: FAIL — ProtocolOptions does not accept `registry`

- [ ] **Step 3: Modify ProtocolOptions to accept registry**

In `packages/core/src/shared/protocol.ts`, add the import at the top:
```typescript
import { HandlerRegistry } from './handler-registry.js';
import type { RequestHandlerFn, NotificationHandlerFn } from './handler-registry.js';
```

Add the `registry` field to the `ProtocolOptions` type (after the `tasks` field, around line 94):
```typescript
    /**
     * External handler registry. When provided, this Protocol instance shares
     * handlers with any other consumer of the same registry. When omitted,
     * Protocol creates its own internal registry (current behavior).
     */
    registry?: HandlerRegistry<BaseContext>;
```

- [ ] **Step 4: Replace private Map fields with registry**

In `packages/core/src/shared/protocol.ts`, replace lines 314-316:

**Before:**
```typescript
    private _requestHandlers: Map<string, (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>> = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _notificationHandlers: Map<string, (notification: JSONRPCNotification) => Promise<void>> = new Map();
```

**After:**
```typescript
    private _registry: HandlerRegistry<ContextT>;
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
```

Note: `_requestHandlerAbortControllers` stays — it's per-request state, not handler definitions.

- [ ] **Step 5: Initialize registry in constructor**

In the constructor (line 350), add registry initialization as the first line of the body:

**Before:**
```typescript
    constructor(private _options?: ProtocolOptions) {
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
```

**After:**
```typescript
    constructor(private _options?: ProtocolOptions) {
        this._registry = (_options?.registry as HandlerRegistry<ContextT> | undefined) ?? new HandlerRegistry<ContextT>();
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
```

The cast is needed because `ProtocolOptions.registry` is typed as `HandlerRegistry<BaseContext>` (the widest context), but Protocol is generic over `ContextT extends BaseContext`. The cast is safe because HandlerRegistry's methods only constrain the handler function signatures, and subclasses always pass compatible context types.

- [ ] **Step 6: Update all handler map accesses**

These are mechanical replacements. Each one is small:

**`_onrequest` (line 556):**
```typescript
// Before:
const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;
// After:
const handler = this._registry.getRequestHandler(request.method) ?? this.fallbackRequestHandler;
```

**`_onnotification` (line 542):**
```typescript
// Before:
const handler = this._notificationHandlers.get(notification.method) ?? this.fallbackNotificationHandler;
// After:
const handler = this._registry.getNotificationHandler(notification.method) ?? this.fallbackNotificationHandler;
```

**`setRequestHandler` implementation (line 1108):**
```typescript
// Before:
this._requestHandlers.set(method, this._wrapHandler(method, stored));
// After:
this._registry.setRequestHandler(method, this._wrapHandler(method, stored));
```

**`removeRequestHandler` (line 1130):**
```typescript
// Before:
this._requestHandlers.delete(method);
// After:
this._registry.removeRequestHandler(method);
```

**`assertCanSetRequestHandler` (line 1137):**
```typescript
// Before:
if (this._requestHandlers.has(method)) {
// After:
if (this._registry.hasRequestHandler(method)) {
```

**`setNotificationHandler` — two lines (lines 1174, 1181):**
```typescript
// Before (line 1174):
this._notificationHandlers.set(method, notification => Promise.resolve(schemasOrHandler(schema.parse(notification))));
// After:
this._registry.setNotificationHandler(method, notification => Promise.resolve(schemasOrHandler(schema.parse(notification))));

// Before (line 1181):
this._notificationHandlers.set(method, async notification => {
// After:
this._registry.setNotificationHandler(method, async notification => {
```

**`removeNotificationHandler` (line 1196):**
```typescript
// Before:
this._notificationHandlers.delete(method);
// After:
this._registry.removeNotificationHandler(method);
```

- [ ] **Step 7: Expose registry getter for subclasses**

Add a protected getter so Server/McpServer can access the registry:

```typescript
    /**
     * The handler registry used by this Protocol instance.
     * Exposed for subclasses that need to share the registry or inspect handlers.
     */
    protected get registry(): HandlerRegistry<ContextT> {
        return this._registry;
    }
```

- [ ] **Step 8: Run the full core test suite**

Run: `pnpm --filter @modelcontextprotocol/core test`
Expected: ALL tests PASS (both new shared-registry tests and all existing tests)

- [ ] **Step 9: Run the full server test suite (catches Server/McpServer regressions)**

Run: `pnpm --filter @modelcontextprotocol/server test`
Expected: ALL tests PASS

- [ ] **Step 10: Run the full client test suite**

Run: `pnpm --filter @modelcontextprotocol/client test`
Expected: ALL tests PASS

- [ ] **Step 11: Typecheck all packages**

Run: `pnpm typecheck:all`
Expected: No type errors

- [ ] **Step 12: Suggest commit**

```
refactor(core): Protocol reads handlers from HandlerRegistry

Extract _requestHandlers and _notificationHandlers maps from
Protocol into a shared HandlerRegistry object. Protocol accepts
an optional registry via ProtocolOptions; creates its own when
not provided (backwards-compatible). Per-request state
(_responseHandlers, _progressHandlers, abort controllers) stays
on Protocol.

This enables multiple Protocol instances (and the future modern
dispatch path) to share the same handler set.
```

---

## Task 3: Server passes registry option through to Protocol

**Files:**
- Modify: `packages/server/src/server/server.ts` (lines 114-121)

Server's constructor already spreads `options` into the Protocol super() call. We just need ServerOptions to accept the registry field. Since ServerOptions extends/includes ProtocolOptions fields, and we added `registry` to ProtocolOptions, this should work if Server spreads correctly.

- [ ] **Step 1: Verify Server already passes options through**

Read `packages/server/src/server/server.ts:114-121`. The constructor is:
```typescript
constructor(
    private _serverInfo: Implementation,
    options?: ServerOptions
) {
    super({
        ...options,
        tasks: extractTaskManagerOptions(options?.capabilities?.tasks)
    });
```

The `...options` spread already passes through any ProtocolOptions fields including the new `registry`. No code change needed in Server if `ServerOptions` includes or extends `ProtocolOptions` fields.

- [ ] **Step 2: Check ServerOptions type**

Find the `ServerOptions` type definition. If it doesn't already include `registry`, verify that the `...options` spread passes it through. If `ServerOptions` is a separate type that doesn't extend `ProtocolOptions`, add `registry?` to it.

- [ ] **Step 3: Write a test that Server accepts and uses a shared registry**

Add to `packages/server/test/server/server.test.ts` (or the appropriate server test file):

```typescript
describe('shared HandlerRegistry', () => {
    it('Server uses an externally-provided registry', () => {
        const registry = new HandlerRegistry<ServerContext>();
        const server = new Server(
            { name: 'test', version: '1.0' },
            { capabilities: { tools: {} }, registry }
        );

        // Server registers its initialize handler in the constructor.
        // That handler should be in the shared registry.
        expect(registry.hasRequestHandler('initialize')).toBe(true);
    });
});
```

- [ ] **Step 4: Run to verify the test passes**

Run: `pnpm --filter @modelcontextprotocol/server test -- -t "shared HandlerRegistry"`
Expected: PASS (if the spread already works) or FAIL (if ServerOptions needs updating)

- [ ] **Step 5: Fix ServerOptions if needed**

If the test fails because `registry` is not recognized in `ServerOptions`, add it:
```typescript
export type ServerOptions = ProtocolOptions & {
    // ... existing fields
};
```
Or add `registry?: HandlerRegistry<ServerContext>` directly if it's not intersection-typed.

- [ ] **Step 6: Run full server test suite**

Run: `pnpm --filter @modelcontextprotocol/server test`
Expected: ALL tests PASS

- [ ] **Step 7: Suggest commit**

```
feat(server): Server accepts shared HandlerRegistry via options

Server's constructor passes the registry option through to Protocol.
This enables McpServer (and future version routers) to share a single
handler registry across multiple Server instances.
```

---

## Task 4: McpServer creates and owns HandlerRegistry

**Files:**
- Modify: `packages/server/src/server/mcp.ts` (constructor, lazy init methods, add `dispatch()` and `registry` getter)
- Create or extend: `packages/server/test/server/mcp.test.ts` or `mcp.compat.test.ts`

McpServer creates a `HandlerRegistry`, passes it to its internal Server, and exposes it. The lazy-init methods (`setToolRequestHandlers`, etc.) write to the registry. A new `dispatch()` method is the modern-path entry point.

- [ ] **Step 1: Write tests for registry exposure and dispatch**

```typescript
describe('McpServer registry and dispatch', () => {
    it('exposes a HandlerRegistry via .registry', () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        expect(server.registry).toBeInstanceOf(HandlerRegistry);
    });

    it('registered tools are visible in the shared registry', () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        server.tool('hello', { description: 'say hello' }, async () => ({
            content: [{ type: 'text', text: 'hello' }]
        }));
        // The compound tools/call handler should be in the registry
        expect(server.registry.hasRequestHandler('tools/call')).toBe(true);
        expect(server.registry.hasRequestHandler('tools/list')).toBe(true);
    });

    it('dispatch() invokes a tools/list handler and returns result', async () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        server.tool('hello', { description: 'say hello' }, async () => ({
            content: [{ type: 'text', text: 'hello' }]
        }));

        const result = await server.dispatch('tools/list', {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
        });

        expect(result).toHaveProperty('tools');
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].name).toBe('hello');
    });

    it('dispatch() invokes a tools/call handler and returns result', async () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        server.tool('greet', { description: 'greet' }, async () => ({
            content: [{ type: 'text', text: 'hi' }]
        }));

        const result = await server.dispatch('tools/call', {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'greet' }
        });

        expect(result).toHaveProperty('content');
    });

    it('dispatch() throws for unregistered method', async () => {
        const server = new McpServer({ name: 'test', version: '1.0' });
        await expect(
            server.dispatch('nonexistent/method', {
                jsonrpc: '2.0', id: 1, method: 'nonexistent/method', params: {}
            })
        ).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/server test -- -t "McpServer registry and dispatch"`
Expected: FAIL — `registry` property and `dispatch` method don't exist yet

- [ ] **Step 3: Add HandlerRegistry to McpServer constructor**

In `packages/server/src/server/mcp.ts`, modify the constructor area (around lines 63-79):

```typescript
import { HandlerRegistry } from '@modelcontextprotocol/core';

export class McpServer {
    public readonly server: Server;
    private _registry: HandlerRegistry<ServerContext>;
    // ... existing private fields ...

    constructor(serverInfo: Implementation, options?: ServerOptions) {
        this._registry = new HandlerRegistry<ServerContext>();
        this.server = new Server(serverInfo, {
            ...options,
            registry: this._registry,
        });
    }

    get registry(): HandlerRegistry<ServerContext> {
        return this._registry;
    }
```

- [ ] **Step 4: Redirect lazy-init methods to use registry**

The lazy-init methods currently call `this.server.setRequestHandler(...)`. This still works because Server.setRequestHandler delegates to the shared registry. No change needed — the existing code paths already write to the shared registry through Server.

Verify this is the case: `this.server.setRequestHandler('tools/list', ...)` → Protocol.setRequestHandler → `this._registry.setRequestHandler(...)` → same registry McpServer created.

- [ ] **Step 5: Add dispatch() method**

Add to `packages/server/src/server/mcp.ts`:

```typescript
    /**
     * Dispatch a JSON-RPC request directly to the appropriate handler.
     * This is the modern (2026-06) path — no Protocol, no transport, no session.
     *
     * The caller (McpVersionRouter) is responsible for building the ServerContext
     * from _meta fields and transport metadata.
     */
    async dispatch(
        method: string,
        request: JSONRPCRequest,
        ctx?: Partial<ServerContext>,
    ): Promise<Result> {
        // Trigger lazy initialization of handlers if not yet done
        this._ensureHandlersInitialized();

        const handler = this._registry.getRequestHandler(method);
        if (!handler) {
            throw new ProtocolError(
                ProtocolErrorCode.MethodNotFound,
                `Method not found: ${method}`
            );
        }

        // Build a minimal context for the handler
        const abortController = new AbortController();
        const baseCtx: ServerContext = {
            sessionId: ctx?.sessionId,
            mcpReq: {
                id: request.id,
                method,
                _meta: request.params?._meta,
                signal: abortController.signal,
                // Modern path: no bidirectional requests, so send/notify are no-ops or throw
                send: ctx?.mcpReq?.send ?? (async () => { throw new Error('Server-to-client requests are not supported in modern mode. Use MRTR (IncompleteResult) instead.'); }),
                notify: ctx?.mcpReq?.notify ?? (async () => {}),
                ...ctx?.mcpReq,
            },
            http: ctx?.http,
        };

        return handler(request, baseCtx);
    }

    /**
     * Ensure all lazy handler registrations have been triggered.
     * Called by dispatch() and by version routers before serving.
     */
    private _ensureHandlersInitialized(): void {
        // Touch each lazy-init path. The methods are idempotent (check their flags).
        if (Object.keys(this._registeredTools).length > 0) {
            this.setToolRequestHandlers();
        }
        if (Object.keys(this._registeredResources).length > 0 ||
            Object.keys(this._registeredResourceTemplates).length > 0) {
            this.setResourceRequestHandlers();
        }
        if (Object.keys(this._registeredPrompts).length > 0) {
            this.setPromptRequestHandlers();
        }
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/server test -- -t "McpServer registry and dispatch"`
Expected: PASS

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `pnpm --filter @modelcontextprotocol/server test`
Expected: ALL tests PASS

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck:all`
Expected: No errors

- [ ] **Step 9: Suggest commit**

```
feat(server): McpServer creates shared HandlerRegistry with dispatch()

McpServer now creates a HandlerRegistry and passes it to its internal
Server. Both share the same handler set. New dispatch() method enables
the modern (2026-06) path: call a handler directly without Protocol,
transport, or session state.
```

---

## Task 5: BridgeTransport

**Files:**
- Create: `packages/server/src/server/bridge-transport.ts`
- Create: `packages/server/test/server/bridge-transport.test.ts`

In-memory Transport implementation for connecting the version router to frozen Server/Protocol instances. Messages pass by reference — no serialization.

- [ ] **Step 1: Write tests**

```typescript
// packages/server/test/server/bridge-transport.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { BridgeTransport } from '../../src/server/bridge-transport.js';

describe('BridgeTransport', () => {
    it('start() resolves immediately', async () => {
        const bridge = new BridgeTransport();
        await expect(bridge.start()).resolves.toBeUndefined();
    });

    it('injectIncoming delivers message via onmessage callback', () => {
        const bridge = new BridgeTransport();
        const onmessage = vi.fn();
        bridge.onmessage = onmessage;

        const request: JSONRPCRequest = {
            jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hello' }
        };
        bridge.injectIncoming(request);

        expect(onmessage).toHaveBeenCalledWith(request, undefined);
    });

    it('injectIncoming passes extra info', () => {
        const bridge = new BridgeTransport();
        const onmessage = vi.fn();
        bridge.onmessage = onmessage;

        const request: JSONRPCRequest = {
            jsonrpc: '2.0', id: 1, method: 'tools/call', params: {}
        };
        const extra = { authInfo: { token: 'xyz' } };
        bridge.injectIncoming(request, extra);

        expect(onmessage).toHaveBeenCalledWith(request, extra);
    });

    it('send() delivers message via onOutgoing callback', async () => {
        const bridge = new BridgeTransport();
        const onOutgoing = vi.fn();
        bridge.onOutgoing = onOutgoing;

        const response: JSONRPCResultResponse = {
            jsonrpc: '2.0', id: 1, result: { content: [] }
        };
        await bridge.send(response);

        expect(onOutgoing).toHaveBeenCalledWith(response);
    });

    it('close() fires onclose callback', async () => {
        const bridge = new BridgeTransport();
        const onclose = vi.fn();
        bridge.onclose = onclose;

        await bridge.close();
        expect(onclose).toHaveBeenCalled();
    });

    it('injectIncoming is a no-op when onmessage is not set', () => {
        const bridge = new BridgeTransport();
        // Should not throw
        bridge.injectIncoming({ jsonrpc: '2.0', id: 1, method: 'test', params: {} });
    });

    it('send is a no-op when onOutgoing is not set', async () => {
        const bridge = new BridgeTransport();
        // Should not throw
        await bridge.send({ jsonrpc: '2.0', id: 1, result: {} });
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/bridge-transport.test.ts`
Expected: FAIL — cannot resolve `bridge-transport.js`

- [ ] **Step 3: Implement BridgeTransport**

```typescript
// packages/server/src/server/bridge-transport.ts
import type { JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/core';

/**
 * In-memory Transport adapter for the legacy bridge.
 *
 * Connects a McpVersionRouter to a frozen Server/Protocol instance.
 * Messages pass by reference — no serialization, no network I/O.
 *
 * - Router calls `injectIncoming()` to deliver client messages to Protocol.
 * - Protocol calls `send()` to emit responses; the router receives them via `onOutgoing`.
 */
export class BridgeTransport implements Transport {
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onOutgoing?: (message: JSONRPCMessage) => void;

    async start(): Promise<void> {}

    injectIncoming(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
        this.onmessage?.(message, extra);
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        this.onOutgoing?.(message);
    }

    async close(): Promise<void> {
        this.onclose?.();
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/bridge-transport.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Suggest commit**

```
feat(server): add BridgeTransport for legacy session bridge

In-memory Transport that connects the version router to frozen
Server/Protocol instances. Messages pass by reference. The router
injects incoming messages; Protocol's outgoing messages come back
via the onOutgoing callback.
```

---

## Task 6: McpVersionRouter abstract base class

**Files:**
- Create: `packages/server/src/server/version-router.ts`
- Create: `packages/server/test/server/version-router.test.ts`

The abstract base with `classify()` as the override point. Provides modern dispatch (via McpServer.dispatch), legacy bridge (via LegacyBridge + BridgeTransport + shared HandlerRegistry), and server/discover handling.

- [ ] **Step 1: Write tests using a concrete test subclass**

```typescript
// packages/server/test/server/version-router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { McpServer } from '../../src/server/mcp.js';
import type { McpEra, TransportMeta } from '../../src/server/version-router.js';
import { McpVersionRouter } from '../../src/server/version-router.js';
import { BridgeTransport } from '../../src/server/bridge-transport.js';

// Concrete test router that always returns a fixed era
class TestRouter extends McpVersionRouter {
    public era: McpEra = 'modern';
    classify(_message: JSONRPCMessage, _meta?: TransportMeta): McpEra {
        return this.era;
    }
}

describe('McpVersionRouter', () => {
    let mcpServer: McpServer;
    let router: TestRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' });
        mcpServer.tool('hello', { description: 'says hello' }, async () => ({
            content: [{ type: 'text', text: 'hello world' }],
        }));
        router = new TestRouter(mcpServer);
    });

    describe('modern dispatch', () => {
        it('dispatches a modern tools/list request via McpServer.dispatch', async () => {
            router.era = 'modern';
            const request: JSONRPCRequest = {
                jsonrpc: '2.0', id: 1, method: 'tools/list', params: {
                    _meta: { protocolVersion: '2026-06-30', clientInfo: { name: 'test', version: '1.0' }, clientCapabilities: {} }
                }
            };

            const result = await router.handleModernRequest(request);
            expect(result).toHaveProperty('tools');
            expect((result as { tools: unknown[] }).tools).toHaveLength(1);
        });
    });

    describe('server/discover', () => {
        it('returns server info and capabilities', async () => {
            const result = await router.handleDiscover();
            expect(result).toHaveProperty('serverInfo');
            expect(result).toHaveProperty('capabilities');
            expect(result.serverInfo.name).toBe('test-server');
        });
    });

    describe('legacy bridge', () => {
        it('creates a legacy session and routes initialize through it', async () => {
            router.era = 'legacy';
            const responses: JSONRPCMessage[] = [];

            const session = router.createLegacySession();
            session.onOutgoing = (msg) => responses.push(msg);

            // Inject initialize request
            session.injectMessage({
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: {
                    protocolVersion: '2025-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0' }
                }
            });

            // Wait for response
            await vi.waitFor(() => {
                expect(responses).toHaveLength(1);
            });

            const response = responses[0] as JSONRPCResultResponse;
            expect(response.result).toHaveProperty('protocolVersion');
            expect(response.result).toHaveProperty('capabilities');
            expect(response.result).toHaveProperty('serverInfo');
        });

        it('legacy session shares handlers with modern path', async () => {
            const session = router.createLegacySession();
            const responses: JSONRPCMessage[] = [];
            session.onOutgoing = (msg) => responses.push(msg);

            // Initialize first
            session.injectMessage({
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: {
                    protocolVersion: '2025-11-05', capabilities: {},
                    clientInfo: { name: 'test', version: '1.0' }
                }
            });
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            responses.length = 0;

            // Send initialized notification
            session.injectMessage({
                jsonrpc: '2.0', method: 'notifications/initialized', params: {}
            });

            // Now call tools/list
            session.injectMessage({
                jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
            });
            await vi.waitFor(() => expect(responses).toHaveLength(1));

            const result = (responses[0] as JSONRPCResultResponse).result as { tools: unknown[] };
            expect(result.tools).toHaveLength(1);
        });
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/version-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement McpVersionRouter**

```typescript
// packages/server/src/server/version-router.ts
import type {
    JSONRPCMessage,
    JSONRPCRequest,
    MessageExtraInfo,
    Result,
    ServerCapabilities,
    Transport,
} from '@modelcontextprotocol/core';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';
import type { McpServer } from './mcp.js';
import { Server } from './server.js';
import { BridgeTransport } from './bridge-transport.js';

export type McpEra = 'legacy' | 'modern';

export interface TransportMeta {
    httpHeaders?: Record<string, string>;
    httpMethod?: string;
    authInfo?: unknown;
    connectionId?: string;
}

export interface LegacySession {
    readonly id: string;
    injectMessage(message: JSONRPCMessage, extra?: MessageExtraInfo): void;
    onOutgoing?: (message: JSONRPCMessage) => void;
    close(): Promise<void>;
    onclose?: () => void;
}

export interface DiscoverResult {
    serverInfo: { name: string; version: string };
    capabilities: ServerCapabilities;
    supportedVersions: string[];
    instructions?: string;
}

export interface VersionRouterOptions {
    legacySupport?: boolean;
    supportedVersions?: string[];
}

let sessionIdCounter = 0;

export abstract class McpVersionRouter {
    constructor(
        protected mcpServer: McpServer,
        protected options?: VersionRouterOptions,
    ) {}

    abstract classify(message: JSONRPCMessage, meta?: TransportMeta): McpEra;

    async handleModernRequest(
        request: JSONRPCRequest,
        meta?: TransportMeta,
    ): Promise<Result> {
        return this.mcpServer.dispatch(request.method, request, {
            http: meta?.authInfo ? { authInfo: meta.authInfo } : undefined,
        });
    }

    handleDiscover(): DiscoverResult {
        return {
            serverInfo: this.mcpServer.server.getServerInfo(),
            capabilities: this.mcpServer.server.getCapabilities(),
            supportedVersions: this.options?.supportedVersions ?? ['2026-06-30', '2025-11-05'],
            instructions: this.mcpServer.server.getInstructions?.(),
        };
    }

    createLegacySession(options?: { sessionId?: string }): LegacySession {
        const id = options?.sessionId ?? `legacy-session-${++sessionIdCounter}`;
        const bridge = new BridgeTransport();
        const server = new Server(
            this.mcpServer.server.getServerInfo(),
            {
                capabilities: this.mcpServer.server.getCapabilities(),
                instructions: this.mcpServer.server.getInstructions?.(),
                registry: this.mcpServer.registry,
            },
        );
        server.connect(bridge);

        const session: LegacySession = {
            id,
            injectMessage(message: JSONRPCMessage, extra?: MessageExtraInfo) {
                bridge.injectIncoming(message, extra);
            },
            set onOutgoing(cb: ((msg: JSONRPCMessage) => void) | undefined) {
                bridge.onOutgoing = cb;
            },
            get onOutgoing() {
                return bridge.onOutgoing;
            },
            async close() {
                await server.close();
                session.onclose?.();
            },
            onclose: undefined,
        };

        return session;
    }

    async serve(transport: Transport): Promise<void> {
        await transport.start();

        transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
            const era = this.classify(message, extra as TransportMeta | undefined);
            if (era === 'modern') {
                if ('method' in message && 'id' in message) {
                    this.handleModernRequest(message as JSONRPCRequest, extra as TransportMeta)
                        .then(result => {
                            transport.send({
                                jsonrpc: '2.0',
                                id: (message as JSONRPCRequest).id,
                                result,
                            });
                        })
                        .catch(error => {
                            const code = error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError;
                            transport.send({
                                jsonrpc: '2.0',
                                id: (message as JSONRPCRequest).id,
                                error: { code, message: error.message },
                            });
                        });
                }
            }
            // Legacy path via persistent transports is left to subclass implementations
            // (HttpVersionRouter uses createLegacySession per HTTP session,
            //  StdioVersionRouter uses a single session for the connection)
        };

        transport.onclose = () => this.close();
    }

    async close(): Promise<void> {
        // Subclasses clean up their specific resources (sessions, subscriptions)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/version-router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm --filter @modelcontextprotocol/server test`
Expected: ALL tests PASS

- [ ] **Step 6: Suggest commit**

```
feat(server): add McpVersionRouter abstract base class

Abstract router with classify() as the single override point.
Provides modern dispatch (via McpServer.dispatch), legacy session
bridge (via shared HandlerRegistry + BridgeTransport), and
server/discover handling.
```

---

## Task 7: HttpVersionRouter

**Files:**
- Create: `packages/server/src/server/http-version-router.ts`
- Create: `packages/server/test/server/http-version-router.test.ts`

HTTP-specific classification using `Mcp-Method` header. Implements both Tier 1 building blocks (classify, handleModernRequest, createLegacySession) and Tier 2 convenience (handleRequest).

- [ ] **Step 1: Write tests for classify()**

```typescript
// packages/server/test/server/http-version-router.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '../../src/server/mcp.js';
import { HttpVersionRouter } from '../../src/server/http-version-router.js';

describe('HttpVersionRouter', () => {
    let mcpServer: McpServer;
    let router: HttpVersionRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test', version: '1.0' });
        router = new HttpVersionRouter(mcpServer, { legacySupport: true });
    });

    describe('classify', () => {
        it('returns modern when Mcp-Method header is present', () => {
            const result = router.classify(
                { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
                { httpHeaders: { 'mcp-method': 'tools/list' } }
            );
            expect(result).toBe('modern');
        });

        it('returns legacy when Mcp-Method header is absent', () => {
            const result = router.classify(
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
                { httpHeaders: {} }
            );
            expect(result).toBe('legacy');
        });

        it('returns legacy when no transport meta', () => {
            const result = router.classify(
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
            );
            expect(result).toBe('legacy');
        });

        it('returns modern for server/discover regardless of headers', () => {
            const result = router.classify(
                { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }
            );
            expect(result).toBe('modern');
        });
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/http-version-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HttpVersionRouter**

```typescript
// packages/server/src/server/http-version-router.ts
import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { isJSONRPCRequest } from '@modelcontextprotocol/core';
import type { McpServer } from './mcp.js';
import type { McpEra, TransportMeta, VersionRouterOptions } from './version-router.js';
import { McpVersionRouter } from './version-router.js';

export class HttpVersionRouter extends McpVersionRouter {
    constructor(mcpServer: McpServer, options?: VersionRouterOptions) {
        super(mcpServer, options);
    }

    classify(message: JSONRPCMessage, meta?: TransportMeta): McpEra {
        // server/discover is always modern
        if (isJSONRPCRequest(message) && message.method === 'server/discover') {
            return 'modern';
        }

        // Mcp-Method header is the definitive HTTP discriminator (SEP-2243).
        // Present in 2026-06 requests, absent in 2025-11 requests.
        if (meta?.httpHeaders?.['mcp-method']) {
            return 'modern';
        }

        return 'legacy';
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/http-version-router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Suggest commit**

```
feat(server): add HttpVersionRouter with Mcp-Method header classification

HTTP-specific version router that uses the Mcp-Method header
(SEP-2243) as the primary discriminator: present = modern 2026-06,
absent = legacy 2025-11. server/discover is always modern.
```

---

## Task 8: StdioVersionRouter

**Files:**
- Create: `packages/server/src/server/stdio-version-router.ts`
- Create: `packages/server/test/server/stdio-version-router.test.ts`

Stdio classification using first message method with connection-era locking.

- [ ] **Step 1: Write tests**

```typescript
// packages/server/test/server/stdio-version-router.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '../../src/server/mcp.js';
import { StdioVersionRouter } from '../../src/server/stdio-version-router.js';

describe('StdioVersionRouter', () => {
    let mcpServer: McpServer;
    let router: StdioVersionRouter;

    beforeEach(() => {
        mcpServer = new McpServer({ name: 'test', version: '1.0' });
        router = new StdioVersionRouter(mcpServer, { legacySupport: true });
    });

    describe('classify', () => {
        it('returns legacy and locks when first message is initialize', () => {
            const result = router.classify({
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
            });
            expect(result).toBe('legacy');

            // Subsequent messages should also be legacy (locked)
            const result2 = router.classify({
                jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
            });
            expect(result2).toBe('legacy');
        });

        it('returns modern and locks when first message is server/discover', () => {
            const result = router.classify({
                jsonrpc: '2.0', id: 1, method: 'server/discover',
                params: { _meta: { protocolVersion: '2026-06-30' } }
            });
            expect(result).toBe('modern');

            // Subsequent messages should also be modern (locked)
            const result2 = router.classify({
                jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
            });
            expect(result2).toBe('modern');
        });

        it('returns modern when first message has _meta.clientCapabilities', () => {
            const result = router.classify({
                jsonrpc: '2.0', id: 1, method: 'tools/list',
                params: { _meta: { protocolVersion: '2026-06-30', clientCapabilities: {}, clientInfo: { name: 'c', version: '1' } } }
            });
            expect(result).toBe('modern');
        });
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/stdio-version-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement StdioVersionRouter**

```typescript
// packages/server/src/server/stdio-version-router.ts
import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { isJSONRPCRequest } from '@modelcontextprotocol/core';
import type { McpServer } from './mcp.js';
import type { McpEra, TransportMeta, VersionRouterOptions } from './version-router.js';
import { McpVersionRouter } from './version-router.js';

export class StdioVersionRouter extends McpVersionRouter {
    private _connectionEra: McpEra | undefined;

    constructor(mcpServer: McpServer, options?: VersionRouterOptions) {
        super(mcpServer, options);
    }

    classify(message: JSONRPCMessage, _meta?: TransportMeta): McpEra {
        // Once locked, all subsequent messages use the same era
        if (this._connectionEra) {
            return this._connectionEra;
        }

        if (isJSONRPCRequest(message)) {
            if (message.method === 'initialize') {
                this._connectionEra = 'legacy';
                return 'legacy';
            }

            if (message.method === 'server/discover') {
                this._connectionEra = 'modern';
                return 'modern';
            }

            if (message.params?._meta?.clientCapabilities) {
                this._connectionEra = 'modern';
                return 'modern';
            }
        }

        // Default for first non-request message: treat as modern
        this._connectionEra = 'modern';
        return 'modern';
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/stdio-version-router.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Suggest commit**

```
feat(server): add StdioVersionRouter with connection-era locking

Stdio-specific version router that determines the era from the
first message: initialize = legacy, server/discover or presence
of _meta.clientCapabilities = modern. Locks the connection to
that era for all subsequent messages.
```

---

## Task 9: Export new classes from server package

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add exports**

Add to `packages/server/src/index.ts`:

```typescript
export { BridgeTransport } from './server/bridge-transport.js';
export {
    McpVersionRouter,
    type McpEra,
    type TransportMeta,
    type LegacySession,
    type DiscoverResult,
    type VersionRouterOptions,
} from './server/version-router.js';
export { HttpVersionRouter } from './server/http-version-router.js';
export { StdioVersionRouter } from './server/stdio-version-router.js';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck:all`
Expected: No errors

- [ ] **Step 3: Lint**

Run: `pnpm lint:all`
Expected: No errors (fix any import ordering issues)

- [ ] **Step 4: Run full test suite**

Run: `pnpm test:all`
Expected: ALL tests PASS across all packages

- [ ] **Step 5: Suggest commit**

```
feat(server): export version router classes from package index

Export McpVersionRouter, HttpVersionRouter, StdioVersionRouter,
BridgeTransport, and associated types from @modelcontextprotocol/server.
```

---

## Task 10: Integration test — dual-era scenario

**Files:**
- Create: `packages/server/test/server/dual-era.test.ts`

End-to-end test: same McpServer instance serves both a modern request (via dispatch) and a legacy session (via bridge), verifying handler sharing and isolation.

- [ ] **Step 1: Write integration tests**

```typescript
// packages/server/test/server/dual-era.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { JSONRPCMessage, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import { McpServer } from '../../src/server/mcp.js';
import { HttpVersionRouter } from '../../src/server/http-version-router.js';

describe('dual-era integration', () => {
    it('modern and legacy paths share the same tool set', async () => {
        const mcpServer = new McpServer({ name: 'dual', version: '1.0' });
        mcpServer.tool('shared-tool', { description: 'works in both eras' }, async () => ({
            content: [{ type: 'text', text: 'result' }],
        }));

        const router = new HttpVersionRouter(mcpServer, { legacySupport: true });

        // Modern path: direct dispatch
        const modernResult = await router.handleModernRequest({
            jsonrpc: '2.0', id: 1, method: 'tools/list',
            params: { _meta: { protocolVersion: '2026-06-30', clientInfo: { name: 'modern', version: '1' }, clientCapabilities: {} } }
        });
        expect((modernResult as { tools: { name: string }[] }).tools[0].name).toBe('shared-tool');

        // Legacy path: via bridge
        const session = router.createLegacySession();
        const responses: JSONRPCMessage[] = [];
        session.onOutgoing = (msg) => responses.push(msg);

        session.injectMessage({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }
        });
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses.length = 0;

        session.injectMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

        session.injectMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        await vi.waitFor(() => expect(responses).toHaveLength(1));

        const legacyResult = (responses[0] as JSONRPCResultResponse).result as { tools: { name: string }[] };
        expect(legacyResult.tools[0].name).toBe('shared-tool');
    });

    it('tool registered after serving is visible to both paths', async () => {
        const mcpServer = new McpServer({ name: 'dual', version: '1.0' });
        mcpServer.tool('initial', { description: 'initial tool' }, async () => ({
            content: [{ type: 'text', text: 'initial' }],
        }));

        const router = new HttpVersionRouter(mcpServer, { legacySupport: true });

        // Create a legacy session
        const session = router.createLegacySession();
        const responses: JSONRPCMessage[] = [];
        session.onOutgoing = (msg) => responses.push(msg);

        session.injectMessage({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } }
        });
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses.length = 0;
        session.injectMessage({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

        // Register a new tool AFTER the legacy session was created
        mcpServer.tool('late-addition', { description: 'added late' }, async () => ({
            content: [{ type: 'text', text: 'late' }],
        }));

        // Modern path sees it
        const modernResult = await router.handleModernRequest({
            jsonrpc: '2.0', id: 1, method: 'tools/list',
            params: { _meta: { protocolVersion: '2026-06-30', clientInfo: { name: 'modern', version: '1' }, clientCapabilities: {} } }
        });
        const modernTools = (modernResult as { tools: { name: string }[] }).tools.map(t => t.name);
        expect(modernTools).toContain('late-addition');

        // Legacy path sees it too (shared HandlerRegistry!)
        session.injectMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        await vi.waitFor(() => expect(responses).toHaveLength(1));

        const legacyTools = ((responses[0] as JSONRPCResultResponse).result as { tools: { name: string }[] }).tools.map(t => t.name);
        expect(legacyTools).toContain('late-addition');
    });

    it('legacy sessions have isolated per-session state', async () => {
        const mcpServer = new McpServer({ name: 'dual', version: '1.0' });
        mcpServer.tool('echo', { description: 'echo' }, async () => ({
            content: [{ type: 'text', text: 'echo' }],
        }));

        const router = new HttpVersionRouter(mcpServer, { legacySupport: true });

        // Create two legacy sessions
        const session1 = router.createLegacySession({ sessionId: 'session-1' });
        const session2 = router.createLegacySession({ sessionId: 'session-2' });

        expect(session1.id).toBe('session-1');
        expect(session2.id).toBe('session-2');

        // Closing one doesn't affect the other
        await session1.close();
        // session2 should still work
        const responses: JSONRPCMessage[] = [];
        session2.onOutgoing = (msg) => responses.push(msg);
        session2.injectMessage({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
        });
        await vi.waitFor(() => expect(responses).toHaveLength(1));
    });
});
```

- [ ] **Step 2: Run integration tests**

Run: `pnpm --filter @modelcontextprotocol/server test -- test/server/dual-era.test.ts`
Expected: All tests PASS

If any fail, investigate and fix the underlying issue in the implementation tasks above. The most likely failure point is the "tool registered after serving" test — this validates the shared HandlerRegistry works end-to-end.

- [ ] **Step 3: Run full test suite one final time**

Run: `pnpm test:all && pnpm typecheck:all && pnpm lint:all`
Expected: Everything PASS

- [ ] **Step 4: Suggest commit**

```
test(server): add dual-era integration tests

Verify that modern dispatch and legacy bridge share the same handler
set via HandlerRegistry, that tools registered after session creation
are visible to both paths, and that legacy sessions have isolated
per-session state.
```

---

## Deferred Work (not in this plan)

These are explicitly deferred to follow-up plans:

| What | Why deferred |
|------|-------------|
| **Subscription management** (`subscriptions/listen`) | Data model is sketched in §7 of the architecture doc. Needs the 2026-06 spec types (subscriptions/listen request/response schemas) to be generated first. |
| **McpServer.connect() deprecation** | Should wait until the router API is validated through real usage. Deprecation warning + internal router creation is a small change. |
| **Migration docs + example updates** | Depends on the API stabilizing. Update `docs/migration.md`, `docs/migration-SKILL.md`, and `examples/server/src/` when the router API is finalized. |
| **Client-side ClientVersionRouter** | Different concerns (probe-once, MRTR retry). Separate plan once server-side is validated. |
| **MRTR (IncompleteResult)** | Architecture supports it (dispatch returns polymorphic Result). Implementation depends on MRTR types being in the schema. |

---

## Execution Notes

- **Task ordering is strict**: Tasks 1→2→3→4→5→6 must be sequential. Tasks 7 and 8 can run in parallel after Task 6. Task 9 depends on 7+8. Task 10 depends on 9.
- **Parallelizable pairs**: (Task 7, Task 8) — HttpVersionRouter and StdioVersionRouter are independent.
- **The critical integration test** is Task 10's "tool registered after serving" — it validates the shared HandlerRegistry works end-to-end. If this fails, the architecture's core premise needs debugging.
- **User preference**: Never run `git add` or `git commit`. Each "Suggest commit" step provides the message; the user runs it manually.
