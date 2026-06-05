# Client Version Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a symmetric client-side version router that probes the server on connect, decides the era (modern or legacy), and configures the Client accordingly. With `forceLegacy`, skips the probe and goes straight to `initialize`. Combined with the existing server-side router, enables all four era combinations for integration testing.

**Architecture:** `ClientVersionRouter` wraps `Client` (composition, symmetric with server-side `McpVersionRouter` wrapping `McpServer`). On connect, it probes the server via `server/discover`. If modern: stores discover result, configures `Protocol.setRequestMeta()` so all outgoing requests include `_meta` fields. If legacy: falls back to `Client.initialize()`. User code continues calling `client.listTools()`, `client.callTool()` etc. unchanged.

**Tech Stack:** TypeScript, Vitest, pnpm monorepo

**Depends on:** The server-side Transport Flip plan (already implemented).

---

## File Map

### New files

| File | Responsibility |
|------|----------------|
| `packages/client/src/client/clientVersionRouter.ts` | `ClientVersionRouter` abstract base — probe, decide era, configure Client |
| `packages/client/src/client/httpClientVersionRouter.ts` | HTTP probe: try modern request, fall back on 400/version error |
| `packages/client/src/client/stdioClientVersionRouter.ts` | Stdio probe: `server/discover`, fall back on -32601 |
| `packages/client/test/client/clientVersionRouter.test.ts` | Tests for ClientVersionRouter via concrete test subclass |
| `packages/client/test/client/httpClientVersionRouter.test.ts` | Tests for HTTP probe + fallback |
| `packages/client/test/client/stdioClientVersionRouter.test.ts` | Tests for stdio probe + fallback |
| `test/integration/test/crossEra.test.ts` | 4-combination integration test matrix |

### Modified files

| File | What changes |
|------|-------------|
| `packages/core/src/shared/protocol.ts` | Add `_requestMeta` field, `setRequestMeta()` method, merge _meta in `_requestWithSchema()` |
| `packages/client/src/client/client.ts` | Extract `initialize()` as public method, add `skipInitialize` option to `connect()` |
| `packages/client/src/index.ts` | Export new router classes and types |
| `packages/server/src/server/versionRouter.ts` | Add `forceLegacy` check before `classify()` |

---

## Task 1: Protocol.setRequestMeta() — _meta injection hook

**Files:**
- Modify: `packages/core/src/shared/protocol.ts`
- Modify: `packages/core/test/shared/protocol.test.ts`

Add a mechanism for the ClientVersionRouter to inject `_meta` fields (protocolVersion, clientInfo, clientCapabilities) into every outgoing request without modifying Client's high-level methods.

- [ ] **Step 1: Write the test**

Add to `packages/core/test/shared/protocol.test.ts`:

```typescript
describe('requestMeta injection', () => {
    it('merges requestMeta into outgoing request _meta', async () => {
        const protocol = createTestProtocol();
        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        protocol.setRequestMeta({
            protocolVersion: '2026-06-30',
            clientInfo: { name: 'test', version: '1.0' },
        });

        // Set up a mock response so the request doesn't time out
        sendSpy.mockImplementation(async (message) => {
            if ('id' in message && 'method' in message) {
                transport.onmessage!({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {}
                });
            }
        });

        protocol.setRequestHandler('tools/list', { params: z.object({}) }, async () => ({}));

        // Send a request from the other side to trigger the protocol's outbound path
        // Actually, we need to test outbound requests, so we use request()
        await protocol.request(
            { method: 'tools/list', params: {} },
            z.object({}),
        );

        // Verify the sent message has _meta
        expect(sendSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'tools/list',
                params: expect.objectContaining({
                    _meta: expect.objectContaining({
                        protocolVersion: '2026-06-30',
                        clientInfo: { name: 'test', version: '1.0' },
                    })
                })
            }),
            expect.anything()
        );
    });

    it('per-request _meta overrides requestMeta', async () => {
        const protocol = createTestProtocol();
        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        protocol.setRequestMeta({ protocolVersion: '2026-06-30' });

        sendSpy.mockImplementation(async (message) => {
            if ('id' in message && 'method' in message) {
                transport.onmessage!({ jsonrpc: '2.0', id: message.id, result: {} });
            }
        });

        await protocol.request(
            { method: 'tools/list', params: { _meta: { logLevel: 'debug' } } },
            z.object({}),
        );

        expect(sendSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                params: expect.objectContaining({
                    _meta: expect.objectContaining({
                        protocolVersion: '2026-06-30',
                        logLevel: 'debug',
                    })
                })
            }),
            expect.anything()
        );
    });

    it('does nothing when requestMeta is not set', async () => {
        const protocol = createTestProtocol();
        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');
        await protocol.connect(transport);

        sendSpy.mockImplementation(async (message) => {
            if ('id' in message && 'method' in message) {
                transport.onmessage!({ jsonrpc: '2.0', id: message.id, result: {} });
            }
        });

        await protocol.request(
            { method: 'tools/list', params: {} },
            z.object({}),
        );

        const sentMessage = sendSpy.mock.calls[0][0];
        expect((sentMessage as any).params?._meta?.protocolVersion).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/core test -- test/shared/protocol.test.ts -t "requestMeta"`
Expected: FAIL — `setRequestMeta` does not exist

- [ ] **Step 3: Implement**

In `packages/core/src/shared/protocol.ts`:

Add field (near the other private fields, around line 321):
```typescript
    private _requestMeta?: Record<string, unknown>;
```

Add public method (near the other public methods):
```typescript
    /**
     * Set metadata fields to merge into every outgoing request's `_meta`.
     * Used by ClientVersionRouter to inject protocolVersion, clientInfo,
     * clientCapabilities in modern (2026-06) mode.
     */
    setRequestMeta(meta: Record<string, unknown> | undefined): void {
        this._requestMeta = meta;
    }
```

In `_requestWithSchema()`, right before the transport.send() call (around line 977), add _meta merge:
```typescript
            // Merge base requestMeta into outgoing request (modern mode _meta injection)
            if (this._requestMeta) {
                jsonrpcRequest.params = {
                    ...jsonrpcRequest.params,
                    _meta: {
                        ...this._requestMeta,
                        ...jsonrpcRequest.params?._meta,
                    }
                };
            }
```

This goes right BEFORE the `this._transport.send(jsonrpcRequest, ...)` call, AFTER the progress handler and task manager blocks. Order matters: `_requestMeta` is the base layer, per-request `_meta` (including progressToken) overrides it.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @modelcontextprotocol/core test`
Expected: ALL tests pass

- [ ] **Step 5: Suggest commit**

```
feat(core): add Protocol.setRequestMeta() for per-request _meta injection

Adds a mechanism to merge base _meta fields (protocolVersion, clientInfo,
clientCapabilities) into every outgoing request. Per-request _meta
overrides the base. Used by ClientVersionRouter for modern mode.
```

---

## Task 2: Client.initialize() extraction + skipInitialize

**Files:**
- Modify: `packages/client/src/client/client.ts`
- Add to: `packages/client/test/client/client.test.ts` (or appropriate test file)

Extract the initialize handshake from `connect()` into a separate public `initialize()` method. Add `skipInitialize` option to `connect()`.

- [ ] **Step 1: Write tests**

```typescript
describe('Client connect modes', () => {
    it('connect with skipInitialize attaches transport without sending initialize', async () => {
        const client = new Client({ name: 'test', version: '1.0' });
        const transport = new MockTransport();
        const sendSpy = vi.spyOn(transport, 'send');

        await client.connect(transport, { skipInitialize: true });

        // Transport attached but no initialize sent
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('initialize() sends the handshake after skipInitialize connect', async () => {
        const client = new Client(
            { name: 'test', version: '1.0' },
            { capabilities: {} }
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        // Set up a minimal server that responds to initialize
        const server = new Server(
            { name: 'test-server', version: '1.0' },
            { capabilities: { tools: {} } }
        );
        await server.connect(serverTransport);

        await client.connect(clientTransport, { skipInitialize: true });

        // Server capabilities not yet available
        expect(client.getServerCapabilities()).toBeUndefined();

        // Now do the initialize handshake
        await client.initialize();

        // Server capabilities now available
        expect(client.getServerCapabilities()).toBeDefined();
        expect(client.getServerCapabilities()?.tools).toBeDefined();
    });

    it('connect without skipInitialize works as before (backwards compat)', async () => {
        const client = new Client(
            { name: 'test', version: '1.0' },
            { capabilities: {} }
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = new Server(
            { name: 'test-server', version: '1.0' },
            { capabilities: { tools: {} } }
        );
        await server.connect(serverTransport);

        await client.connect(clientTransport);

        expect(client.getServerCapabilities()?.tools).toBeDefined();
    });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/client test -- -t "Client connect modes"`
Expected: FAIL — `skipInitialize` and `initialize()` don't exist

- [ ] **Step 3: Extract initialize() from connect()**

In `packages/client/src/client/client.ts`, modify `connect()` and add `initialize()`:

The current `connect()` (lines 484-541) does: `super.connect(transport)` → initialize handshake → store capabilities. Split it:

```typescript
    override async connect(transport: Transport, options?: RequestOptions & { skipInitialize?: boolean }): Promise<void> {
        await super.connect(transport);

        if (transport.sessionId !== undefined) {
            if (this._negotiatedProtocolVersion !== undefined && transport.setProtocolVersion) {
                transport.setProtocolVersion(this._negotiatedProtocolVersion);
            }
            return;
        }

        if (options?.skipInitialize) {
            return;
        }

        await this.initialize(options);
    }

    /**
     * Perform the initialize handshake with the server.
     * Normally called automatically by connect(). Call manually after
     * connect({ skipInitialize: true }) when the version router decides
     * to use the legacy protocol path.
     */
    async initialize(options?: RequestOptions): Promise<void> {
        try {
            const result = await this._requestWithSchema(
                {
                    method: 'initialize',
                    params: {
                        protocolVersion: this._supportedProtocolVersions[0] ?? LATEST_PROTOCOL_VERSION,
                        capabilities: this._capabilities,
                        clientInfo: this._clientInfo
                    }
                },
                InitializeResultSchema,
                options
            );

            if (result === undefined) {
                throw new Error(`Server sent invalid initialize result: ${result}`);
            }

            if (!this._supportedProtocolVersions.includes(result.protocolVersion)) {
                throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
            }

            this._serverCapabilities = result.capabilities;
            this._serverVersion = result.serverInfo;
            this._negotiatedProtocolVersion = result.protocolVersion;
            if (this.transport?.setProtocolVersion) {
                this.transport.setProtocolVersion(result.protocolVersion);
            }

            this._instructions = result.instructions;

            await this.notification({ method: 'notifications/initialized' });

            if (this._pendingListChangedConfig) {
                this._setupListChangedHandlers(this._pendingListChangedConfig);
                this._pendingListChangedConfig = undefined;
            }
        } catch (error) {
            void this.close();
            throw error;
        }
    }
```

Note: You'll need to check whether `this.transport` is accessible (it's `_transport` on Protocol and may be private). If so, use the transport reference from connect's argument or add a getter. Read the code to verify.

Also expose setters for server info that the ClientVersionRouter can call after `server/discover`:

```typescript
    /**
     * Store server info from a server/discover response.
     * Used by ClientVersionRouter when in modern mode (no initialize handshake).
     */
    setServerInfo(info: {
        capabilities: ServerCapabilities;
        serverInfo: Implementation;
        instructions?: string;
    }): void {
        this._serverCapabilities = info.capabilities;
        this._serverVersion = info.serverInfo;
        this._instructions = info.instructions;
    }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @modelcontextprotocol/client test`
Expected: ALL tests pass (new + existing)

- [ ] **Step 5: Run full suite**

Run: `pnpm test:all && pnpm typecheck:all`
Expected: Everything passes

- [ ] **Step 6: Suggest commit**

```
refactor(client): extract Client.initialize() from connect()

Split the initialize handshake into a separate public method.
connect({ skipInitialize: true }) attaches the transport without
sending initialize. Client.setServerInfo() stores server info
from a discover response. Enables ClientVersionRouter to control
the handshake sequence.
```

---

## Task 3: ClientVersionRouter abstract base

**Files:**
- Create: `packages/client/src/client/clientVersionRouter.ts`
- Create: `packages/client/test/client/clientVersionRouter.test.ts`

Abstract base with `probe()` as the subclass override point. Wraps Client, manages the era decision, configures _meta injection for modern mode.

- [ ] **Step 1: Write tests using a concrete test subclass**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '../../src/client/client.js';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import type { McpEra } from '@modelcontextprotocol/server';
import { ClientVersionRouter } from '../../src/client/clientVersionRouter.js';

// Test router that resolves to a fixed era
class TestClientRouter extends ClientVersionRouter {
    public probeResult: McpEra = 'modern';
    public probeCalled = false;

    protected async probe(): Promise<McpEra> {
        this.probeCalled = true;
        return this.probeResult;
    }
}

describe('ClientVersionRouter', () => {
    let client: Client;
    let mcpServer: McpServer;

    beforeEach(() => {
        client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });
        mcpServer = new McpServer({ name: 'test-server', version: '1.0' });
        mcpServer.registerTool('echo', { description: 'echo' }, async () => ({
            content: [{ type: 'text', text: 'hello' }]
        }));
    });

    describe('modern mode', () => {
        it('probes and enters modern mode when probe returns modern', async () => {
            const router = new TestClientRouter(client);
            router.probeResult = 'modern';

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            // For modern mode, we need a server that handles raw requests
            // Use the server-side version router
            const { HttpVersionRouter } = await import('@modelcontextprotocol/server');
            const serverRouter = new HttpVersionRouter(mcpServer);
            // ... wire transport to serverRouter for modern dispatch

            await router.connect(clientTransport);
            expect(router.era).toBe('modern');
            expect(router.probeCalled).toBe(true);
        });
    });

    describe('legacy mode', () => {
        it('falls back to legacy when probe returns legacy', async () => {
            const router = new TestClientRouter(client);
            router.probeResult = 'legacy';

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const { Server } = await import('@modelcontextprotocol/server');
            const server = new Server(
                { name: 'test-server', version: '1.0' },
                { capabilities: { tools: {} } }
            );
            await server.connect(serverTransport);

            await router.connect(clientTransport);
            expect(router.era).toBe('legacy');

            // Client works normally
            const tools = await client.listTools();
            expect(tools.tools).toHaveLength(1);
        });
    });

    describe('forceLegacy', () => {
        it('skips probe when forceLegacy is true', async () => {
            const router = new TestClientRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const { Server } = await import('@modelcontextprotocol/server');
            const server = new Server(
                { name: 'test-server', version: '1.0' },
                { capabilities: { tools: {} } }
            );
            await server.connect(serverTransport);

            await router.connect(clientTransport);
            expect(router.era).toBe('legacy');
            expect(router.probeCalled).toBe(false);

            const tools = await client.listTools();
            expect(tools.tools).toHaveLength(1);
        });
    });
});
```

Note: The modern-mode test is harder to wire up because we need a server that handles raw modern requests. The test subclass can use `probeResult` to simulate the probe without a real server. The full end-to-end test goes in the integration test file (Task 8).

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm --filter @modelcontextprotocol/client test -- test/client/clientVersionRouter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ClientVersionRouter**

```typescript
// packages/client/src/client/clientVersionRouter.ts
import type { Transport } from '@modelcontextprotocol/core';
import type { Client } from './client.js';

export type McpEra = 'legacy' | 'modern';

export interface ClientVersionRouterOptions {
    forceLegacy?: boolean;
}

export abstract class ClientVersionRouter {
    private _era: McpEra | undefined;

    constructor(
        protected client: Client,
        protected options?: ClientVersionRouterOptions,
    ) {}

    get era(): McpEra | undefined {
        return this._era;
    }

    /**
     * Subclass override: probe the server to determine era.
     * Called after the transport is connected but before initialize.
     * Should send server/discover (stdio) or try a modern request (HTTP).
     * Returns 'modern' if server supports 2026-06, 'legacy' if not.
     */
    protected abstract probe(): Promise<McpEra>;

    async connect(transport: Transport): Promise<void> {
        if (this.options?.forceLegacy) {
            await this.client.connect(transport);
            this._era = 'legacy';
            return;
        }

        // Connect without initialize — let probe decide
        await this.client.connect(transport, { skipInitialize: true });

        try {
            this._era = await this.probe();
        } catch {
            // Probe failed — fall back to legacy
            this._era = 'legacy';
        }

        if (this._era === 'legacy') {
            await this.client.initialize();
        } else {
            // Modern mode: configure _meta injection on all outgoing requests
            this.client.setRequestMeta({
                protocolVersion: '2026-06-30',
                clientInfo: this.client.getClientInfo(),
                clientCapabilities: this.client.getClientCapabilities(),
            });
        }
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
```

Note: You'll need to check whether `Client` exposes `getClientInfo()` and `getClientCapabilities()`. If not, add simple getters (like we did for Server). Read `client.ts` to verify.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @modelcontextprotocol/client test`
Expected: ALL tests pass

- [ ] **Step 5: Suggest commit**

```
feat(client): add ClientVersionRouter abstract base

Wraps Client with era-aware connect logic. Probes the server to
determine era (modern or legacy). In modern mode, configures
Protocol.setRequestMeta() for _meta injection. forceLegacy skips
the probe and goes straight to initialize.
```

---

## Task 4: StdioClientVersionRouter

**Files:**
- Create: `packages/client/src/client/stdioClientVersionRouter.ts`
- Create: `packages/client/test/client/stdioClientVersionRouter.test.ts`

Probes with `server/discover`. Falls back to legacy on `-32601`.

- [ ] **Step 1: Write tests**

```typescript
describe('StdioClientVersionRouter', () => {
    it('enters modern mode when server/discover succeeds', async () => {
        // ... setup with McpServer + StdioVersionRouter that supports discover
    });

    it('falls back to legacy when server/discover returns -32601', async () => {
        // ... setup with legacy-only Server (no discover handler)
    });

    it('stores server info from discover result', async () => {
        // ... verify client.getServerCapabilities() is set after modern probe
    });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/client/src/client/stdioClientVersionRouter.ts
import type { McpEra } from './clientVersionRouter.js';
import { ClientVersionRouter } from './clientVersionRouter.js';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';

export class StdioClientVersionRouter extends ClientVersionRouter {
    protected async probe(): Promise<McpEra> {
        try {
            const result = await this.client.request(
                {
                    method: 'server/discover',
                    params: {
                        _meta: { protocolVersion: '2026-06-30' }
                    }
                },
                DiscoverResultSchema,
            );

            // Store server info from discover
            this.client.setServerInfo({
                capabilities: result.capabilities,
                serverInfo: result.serverInfo,
                instructions: result.instructions,
            });

            return 'modern';
        } catch (e) {
            if (e instanceof ProtocolError && e.code === ProtocolErrorCode.MethodNotFound) {
                return 'legacy';
            }
            throw e;
        }
    }
}
```

Note: You'll need to find or create a `DiscoverResultSchema` (Zod schema for the server/discover response). Check if one already exists in the types. If not, create a minimal one matching the DiscoverResult interface.

- [ ] **Step 3: Run tests and verify**

- [ ] **Step 4: Suggest commit**

---

## Task 5: HttpClientVersionRouter

**Files:**
- Create: `packages/client/src/client/httpClientVersionRouter.ts`
- Create: `packages/client/test/client/httpClientVersionRouter.test.ts`

Probes by trying a modern request (or server/discover with Mcp-Method header). Falls back on 400 or `UnsupportedProtocolVersionError`.

- [ ] **Step 1: Write tests**

```typescript
describe('HttpClientVersionRouter', () => {
    it('enters modern mode when server accepts modern request', async () => { ... });
    it('falls back to legacy on 400 / UnsupportedProtocolVersionError', async () => { ... });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/client/src/client/httpClientVersionRouter.ts
import type { McpEra } from './clientVersionRouter.js';
import { ClientVersionRouter } from './clientVersionRouter.js';

export class HttpClientVersionRouter extends ClientVersionRouter {
    protected async probe(): Promise<McpEra> {
        try {
            const result = await this.client.request(
                {
                    method: 'server/discover',
                    params: { _meta: { protocolVersion: '2026-06-30' } }
                },
                DiscoverResultSchema,
            );

            this.client.setServerInfo({
                capabilities: result.capabilities,
                serverInfo: result.serverInfo,
                instructions: result.instructions,
            });

            return 'modern';
        } catch (e) {
            // 400, UnsupportedProtocolVersionError, or -32601 → legacy
            return 'legacy';
        }
    }
}
```

Note: HTTP probe may differ from stdio in error handling (HTTP 400 vs JSON-RPC -32601). The transport may surface HTTP errors differently. Read the StreamableHTTPClientTransport to understand error shapes, then adapt accordingly.

- [ ] **Step 3: Run tests and verify**

- [ ] **Step 4: Suggest commit**

---

## Task 6: Server-side forceLegacy

**Files:**
- Modify: `packages/server/src/server/versionRouter.ts`
- Add to: `packages/server/test/server/versionRouter.test.ts`

Add `forceLegacy` check to `McpVersionRouter` before calling `classify()`.

- [ ] **Step 1: Write test**

```typescript
it('forceLegacy bypasses classify and always returns legacy', async () => {
    const router = new TestRouter(mcpServer, { forceLegacy: true });
    router.era = 'modern'; // classify would return modern

    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    // But forceLegacy should override classify
    // Test that serve() routes to legacy path, not modern
});
```

- [ ] **Step 2: Implement**

In `packages/server/src/server/versionRouter.ts`, add `forceLegacy?` to `VersionRouterOptions`:

```typescript
export interface VersionRouterOptions {
    legacySupport?: boolean;
    forceLegacy?: boolean;
    supportedVersions?: string[];
}
```

In the `serve()` method, check before classify:
```typescript
transport.onmessage = (message, extra) => {
    const era = this.options?.forceLegacy
        ? 'legacy'
        : this.classify(message, extra as TransportMeta);
    // ... rest unchanged
};
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Suggest commit**

---

## Task 7: Export new client classes

**Files:**
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Add exports**

```typescript
export type { ClientVersionRouterOptions, McpEra } from './client/clientVersionRouter.js';
export { ClientVersionRouter } from './client/clientVersionRouter.js';
export { HttpClientVersionRouter } from './client/httpClientVersionRouter.js';
export { StdioClientVersionRouter } from './client/stdioClientVersionRouter.js';
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck:all && pnpm lint:fix:all`

- [ ] **Step 3: Suggest commit**

---

## Task 8: Cross-era integration tests

**Files:**
- Create: `test/integration/test/crossEra.test.ts`

The 4-combination matrix using `InMemoryTransport`:

| # | Client | Server | Expected behavior |
|---|--------|--------|-------------------|
| 1 | forceLegacy | forceLegacy | Both use initialize handshake, legacy path throughout |
| 2 | default (probes modern) | default (dual) | Client probes server/discover, gets modern response, _meta per-request |
| 3 | default (probes modern) | forceLegacy | Client probes, server responds with -32601, client falls back to initialize |
| 4 | forceLegacy | default (dual) | Client skips probe, sends initialize, server routes to legacy bridge |

- [ ] **Step 1: Write integration tests**

```typescript
// test/integration/test/crossEra.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientVersionRouter } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer, StdioVersionRouter } from '@modelcontextprotocol/server';

function createTestServer() {
    const mcpServer = new McpServer({ name: 'test-server', version: '1.0' });
    mcpServer.registerTool('ping', { description: 'ping' }, async () => ({
        content: [{ type: 'text', text: 'pong' }]
    }));
    return mcpServer;
}

describe('Cross-era integration tests', () => {
    describe('1: Legacy client + Legacy server', () => {
        it('both use initialize handshake', async () => {
            const mcpServer = createTestServer();
            const serverRouter = new StdioVersionRouter(mcpServer, { forceLegacy: true });
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const clientRouter = new StdioClientVersionRouter(client, { forceLegacy: true });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Server serves on its transport
            // Client connects on its transport
            // ... wire up serve() or use legacy session + injectMessage bridge

            // Verify tools work
            const tools = await client.listTools();
            expect(tools.tools[0].name).toBe('ping');
        });
    });

    describe('2: Modern client + Modern server', () => {
        it('client probes discover, both use _meta per-request', async () => {
            const mcpServer = createTestServer();
            const serverRouter = new StdioVersionRouter(mcpServer);
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const clientRouter = new StdioClientVersionRouter(client);

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            // Wire up and connect
            // ...

            expect(clientRouter.era).toBe('modern');
            const tools = await client.listTools();
            expect(tools.tools[0].name).toBe('ping');
        });
    });

    describe('3: Modern client + Legacy server (fallback)', () => {
        it('client probes, server rejects, client falls back to initialize', async () => {
            const mcpServer = createTestServer();
            const serverRouter = new StdioVersionRouter(mcpServer, { forceLegacy: true });
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const clientRouter = new StdioClientVersionRouter(client);

            // ... wire up

            expect(clientRouter.era).toBe('legacy');
            const tools = await client.listTools();
            expect(tools.tools[0].name).toBe('ping');
        });
    });

    describe('4: Legacy client + Dual server', () => {
        it('client sends initialize, server routes to legacy bridge', async () => {
            const mcpServer = createTestServer();
            const serverRouter = new StdioVersionRouter(mcpServer);
            const client = new Client({ name: 'test', version: '1.0' }, { capabilities: {} });
            const clientRouter = new StdioClientVersionRouter(client, { forceLegacy: true });

            // ... wire up

            expect(clientRouter.era).toBe('legacy');
            const tools = await client.listTools();
            expect(tools.tools[0].name).toBe('ping');
        });
    });
});
```

Note: The wiring between client and server via InMemoryTransport + version routers needs careful implementation. The server router's `serve()` method handles modern requests but the legacy path through `serve()` is incomplete. The implementer may need to wire legacy sessions manually or extend `serve()` to handle both eras on persistent transports. Read the current `serve()` implementation and decide the best approach.

- [ ] **Step 2: Run integration tests**

Run: `pnpm --filter integration test -- test/crossEra.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 3: Run full suite**

Run: `pnpm test:all && pnpm typecheck:all && pnpm lint:fix:all`
Expected: Everything passes

- [ ] **Step 4: Suggest commit**

```
test: cross-era integration tests for all client/server combinations

Tests the 4-combination matrix: legacy↔legacy, modern↔modern,
modern client→legacy server (fallback), legacy client→dual server.
Validates that forceLegacy works on both sides and that the probe
sequence correctly detects server era.
```

---

## Execution Notes

- **Task ordering**: 1→2→3→(4,5 parallel)→6→7→8
- **Parallelizable**: Tasks 4 and 5 (StdioClientVersionRouter, HttpClientVersionRouter)
- **Critical integration point**: Task 8 requires server-side `serve()` to handle both modern and legacy messages on a persistent transport. The current `serve()` only handles modern. The implementer will need to extend it or wire up the legacy path manually for the tests.
- **MRTR**: Sketched in the architecture doc §6. The retry loop would live in `ClientVersionRouter.callTool()` or a wrapper — deferred to a future plan.
- **User preference**: Never run `git add` or `git commit`. Each "Suggest commit" step provides the message; the user runs it manually.
