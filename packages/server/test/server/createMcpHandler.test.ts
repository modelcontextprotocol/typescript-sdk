/**
 * createMcpHandler: the dual-era HTTP entry.
 *
 * Covers the two legacy postures ('stateless' — the default — and 'reject' →
 * modern-only strict), the isLegacyRequest predicate and the user-land routing
 * pattern that replaces the removed handler-valued legacy option, the handler
 * faces, the per-request era write + client-identity backfill, notification
 * routing, the response-mode knob, and close() teardown of the modern leg.
 */
import { Readable } from 'node:stream';

import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import type { McpRequestContext, NodeServerResponseLike } from '../../src/server/createMcpHandler.js';
import { createMcpHandler, isLegacyRequest } from '../../src/server/createMcpHandler.js';
import { McpServer } from '../../src/server/mcp.js';
import { PerRequestHTTPServerTransport } from '../../src/server/perRequestTransport.js';

const MODERN_REVISION = '2026-07-28';

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'entry-test-client', version: '3.2.1' },
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } }
};

interface JSONRPCErrorBody {
    jsonrpc: string;
    id: unknown;
    error: { code: number; message: string; data?: Record<string, unknown> };
}

function modernToolsCall(name: string, args: Record<string, unknown>, envelope: Record<string, unknown> = ENVELOPE): unknown {
    return {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args, _meta: envelope }
    };
}

/**
 * The SEP-2243 standard headers a conformant client derives from the body it
 * sends. Only emitted for a body carrying a modern envelope claim, so legacy
 * test cells stay byte-untouched; spread before any explicit `headers` so a
 * caller that needs to test a stripped or disagreeing header can override.
 */
function bodyDerivedStandardHeaders(body: unknown): Record<string, string> {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
    const b = body as { method?: unknown; params?: { name?: unknown; uri?: unknown; _meta?: Record<string, unknown> } };
    if (typeof b.params?._meta?.[PROTOCOL_VERSION_META_KEY] !== 'string') return {};
    const out: Record<string, string> = {};
    if (typeof b.method === 'string') out['mcp-method'] = b.method;
    const name = b.method === 'resources/read' ? b.params.uri : b.params.name;
    if (typeof name === 'string') out['mcp-name'] = name;
    return out;
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...bodyDerivedStandardHeaders(body),
            ...headers
        },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
}

interface TestFactoryState {
    contexts: McpRequestContext[];
    products: McpServer[];
    oninitializedCalls: number;
}

function testFactory(): { factory: (ctx: McpRequestContext) => McpServer; state: TestFactoryState } {
    const state: TestFactoryState = { contexts: [], products: [], oninitializedCalls: 0 };
    const factory = (ctx: McpRequestContext): McpServer => {
        state.contexts.push(ctx);
        const mcpServer = new McpServer({ name: 'entry-test-server', version: '1.0.0' });
        mcpServer.server.oninitialized = () => {
            state.oninitializedCalls += 1;
        };
        mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        mcpServer.registerTool('whoami', { inputSchema: z.object({}) }, async (_args, ctx2) => ({
            content: [{ type: 'text', text: ctx2.http?.authInfo?.clientId ?? 'anonymous' }]
        }));
        mcpServer.registerTool('progress-then-echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }, ctx2) => {
            await ctx2.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } });
            return { content: [{ type: 'text', text }] };
        });
        mcpServer.registerTool('park', { inputSchema: z.object({}) }, async (_args, ctx2) => {
            await new Promise<void>(resolve => {
                ctx2.mcpReq.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return { content: [{ type: 'text', text: 'aborted' }] };
        });
        state.products.push(mcpServer);
        return mcpServer;
    };
    return { factory, state };
}

describe('createMcpHandler — modern path', () => {
    it('serves an envelope-carrying request on a fresh modern instance', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'hello' })));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('hello');

        expect(state.contexts).toHaveLength(1);
        expect(state.contexts[0]?.era).toBe('modern');
        expect(state.contexts[0]?.requestInfo).toBeInstanceOf(Request);
    });

    it('serves server/discover on the modern path with the modern supported list', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(
            postRequest({ jsonrpc: '2.0', id: 5, method: 'server/discover', params: { _meta: ENVELOPE } })
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { supportedVersions: string[]; serverInfo: { name: string } } };
        expect(body.result.supportedVersions).toEqual([MODERN_REVISION]);
        expect(body.result.serverInfo.name).toBe('entry-test-server');
    });

    it('backfills the deprecated accessors and the negotiated revision from the validated envelope (per-request instance state)', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'x' })));
        expect(response.status).toBe(200);

        const server = state.products[0]!.server;
        expect(server.getClientVersion()).toEqual({ name: 'entry-test-client', version: '3.2.1' });
        expect(server.getClientCapabilities()).toEqual({ elicitation: { form: {} } });
        expect(server.getNegotiatedProtocolVersion()).toBe(MODERN_REVISION);
    });

    it('never fires oninitialized on the modern path and never needs setProtocolVersion on the per-request transport', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        // A 2026-classified `notifications/initialized` (modern header, no body claim)
        // is acknowledged but the era registry has no such notification, so the
        // legacy lifecycle callback structurally cannot fire.
        const response = await handler.fetch(
            postRequest(
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { 'mcp-protocol-version': MODERN_REVISION, 'mcp-method': 'notifications/initialized' }
            )
        );
        expect(response.status).toBe(202);
        expect(state.oninitializedCalls).toBe(0);

        // The legacy transport's setProtocolVersion side effect is moot by construction:
        // the per-request transport does not implement the optional hook at all.
        const transport = new PerRequestHTTPServerTransport({ classification: { era: 'modern', revision: MODERN_REVISION } });
        expect((transport as { setProtocolVersion?: unknown }).setProtocolVersion).toBeUndefined();
    });

    it('passes caller-supplied authInfo through to handler context and never derives it from headers', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const withAuth = await handler.fetch(postRequest(modernToolsCall('whoami', {})), {
            authInfo: { token: 'verified', clientId: 'client-7', scopes: [] }
        });
        const withAuthBody = (await withAuth.json()) as { result: { content: Array<{ text: string }> } };
        expect(withAuthBody.result.content[0]?.text).toBe('client-7');

        const withoutAuth = await handler.fetch(postRequest(modernToolsCall('whoami', {}), { authorization: 'Bearer raw-header-token' }));
        const withoutAuthBody = (await withoutAuth.json()) as { result: { content: Array<{ text: string }> } };
        expect(withoutAuthBody.result.content[0]?.text).toBe('anonymous');
    });

    it('answers era-removed and unknown methods with method-not-found over HTTP 404', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const eraRemoved = await handler.fetch(
            postRequest({ jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: { level: 'info', _meta: ENVELOPE } })
        );
        expect(eraRemoved.status).toBe(404);
        const eraRemovedBody = (await eraRemoved.json()) as JSONRPCErrorBody;
        expect(eraRemovedBody.error.code).toBe(-32_601);
        expect(eraRemovedBody.id).toBe(2);

        const unknown = await handler.fetch(postRequest({ jsonrpc: '2.0', id: 3, method: 'no/such-method', params: { _meta: ENVELOPE } }));
        expect(unknown.status).toBe(404);
        const unknownBody = (await unknown.json()) as JSONRPCErrorBody;
        expect(unknownBody.error.code).toBe(-32_601);
        expect(unknownBody.id).toBe(3);
    });

    it('rejects an envelope claiming a revision the endpoint does not serve with the supported list', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(
            postRequest(modernToolsCall('echo', { text: 'x' }, { ...ENVELOPE, [PROTOCOL_VERSION_META_KEY]: '2030-01-01' }))
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_004);
        expect(body.error.data?.['supported']).toEqual([MODERN_REVISION]);
        expect(body.error.data?.['requested']).toBe('2030-01-01');
        expect(body.id).toBe(1);
        expect(state.contexts).toHaveLength(0);
    });

    it('rejects a header/body protocol-version mismatch with -32001 (HeaderMismatch) over HTTP 400', async () => {
        const { factory } = testFactory();
        const onerror = vi.fn();
        const handler = createMcpHandler(factory, { onerror });

        const response = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'x' }), { 'mcp-protocol-version': '2025-11-25' }));
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_001);
        // The rejection echoes the request id.
        expect(body.id).toBe(1);
        expect(onerror).toHaveBeenCalled();
    });

    it('rejects a modern-classified request without a _meta envelope with -32602 naming the missing key over HTTP 400', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        // The MCP-Protocol-Version header names the modern revision but the body
        // carries no per-request envelope: invalid params naming what is missing,
        // not a version error and not silent legacy serving.
        const response = await handler.fetch(
            postRequest(
                { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
                { 'mcp-protocol-version': MODERN_REVISION, 'mcp-method': 'tools/list' }
            )
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_602);
        expect(JSON.stringify(body.error.data)).toContain('_meta');
        expect(body.id).toBe(11);
        expect(state.contexts).toHaveLength(0);
    });

    it('answers entry-internal failures with 500/-32603 and reports them through onerror', async () => {
        const onerror = vi.fn();
        const handler = createMcpHandler(
            () => {
                throw new Error('factory exploded');
            },
            { onerror }
        );

        const response = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'x' })));
        expect(response.status).toBe(500);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_603);
        expect(body.id).toBe(1);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'factory exploded' }));
    });

    it('closes and releases the per-request instance when a modern exchange fails internally', async () => {
        const { factory, state } = testFactory();
        const onerror = vi.fn();
        let closeCalls = 0;
        const failingFactory = (ctx: McpRequestContext): McpServer => {
            const product = factory(ctx);
            vi.spyOn(product.server, 'connect').mockRejectedValue(new Error('connect exploded'));
            const realClose = product.server.close.bind(product.server);
            product.server.close = async () => {
                closeCalls += 1;
                await realClose();
            };
            return product;
        };
        const handler = createMcpHandler(failingFactory, { onerror });

        const response = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'x' })));
        expect(response.status).toBe(500);
        expect(((await response.json()) as JSONRPCErrorBody).error.code).toBe(-32_603);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'connect exploded' }));
        expect(state.contexts).toHaveLength(1);

        // The failed exchange's instance was closed and released from the
        // in-flight set: the handler's own close() finds nothing to tear down.
        expect(closeCalls).toBe(1);
        await handler.close();
        expect(closeCalls).toBe(1);
    });

    it('rejects a malformed envelope behind a present claim with invalid params naming the offending key', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(
            postRequest(modernToolsCall('echo', { text: 'x' }, { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION }))
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_602);
        expect(JSON.stringify(body.error.data)).toContain('clientInfo');
        expect(body.id).toBe(1);
        expect(state.contexts).toHaveLength(0);
    });
});

describe("createMcpHandler — modern-only strict (legacy: 'reject')", () => {
    it('rejects envelope-less requests with the unsupported-protocol-version error and the supported list', async () => {
        const { factory, state } = testFactory();
        const onerror = vi.fn();
        const handler = createMcpHandler(factory, { legacy: 'reject', onerror });

        const response = await handler.fetch(
            postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } })
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_004);
        expect(body.error.data?.['supported']).toEqual([MODERN_REVISION]);
        expect(body.id).toBe(1);
        expect(state.contexts).toHaveLength(0);
        expect(onerror).toHaveBeenCalled();
    });

    it('rejects an envelope-less initialize naming the supported and requested versions', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });

        const response = await handler.fetch(
            postRequest({
                jsonrpc: '2.0',
                id: 'init-1',
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', clientInfo: { name: 'legacy', version: '1.0' }, capabilities: {} }
            })
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_004);
        expect(body.error.data?.['supported']).toEqual([MODERN_REVISION]);
        expect(body.error.data?.['requested']).toBe('2025-11-25');
        expect(body.id).toBe('init-1');
    });

    it('answers GET and DELETE with 405 Method not allowed', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });

        for (const method of ['GET', 'DELETE']) {
            const response = await handler.fetch(new Request('http://localhost/mcp', { method }));
            expect(response.status).toBe(405);
            const body = (await response.json()) as JSONRPCErrorBody;
            expect(body.error.code).toBe(-32_000);
            expect(body.error.message).toBe('Method not allowed.');
            // Body-less methods carry no request id to echo.
            expect(body.id).toBeNull();
        }
    });

    it('rejects batch and response-body POSTs as invalid requests', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });

        const batch = await handler.fetch(postRequest([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]));
        expect(batch.status).toBe(400);
        const batchBody = (await batch.json()) as JSONRPCErrorBody;
        expect(batchBody.error.code).toBe(-32_600);
        // A whole-array rejection corresponds to no single request: id stays null.
        expect(batchBody.id).toBeNull();

        const responseBody = await handler.fetch(postRequest({ jsonrpc: '2.0', id: 9, result: { ok: true } }));
        expect(responseBody.status).toBe(400);
        const responseBodyJson = (await responseBody.json()) as JSONRPCErrorBody;
        expect(responseBodyJson.error.code).toBe(-32_600);
        // A posted response is not a request; there is no request id to echo.
        expect(responseBodyJson.id).toBeNull();
    });

    it('answers unparseable JSON with a parse error', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });

        const response = await handler.fetch(postRequest('{not json'));
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_700);
        // The id could not be read from the malformed body, so it stays null.
        expect(body.id).toBeNull();
    });

    it('acknowledges and drops legacy-classified notifications (202, never dispatched)', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });

        const response = await handler.fetch(
            postRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-method': 'something/else' })
        );
        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
        // Never dispatched: no instance was even constructed, and the Mcp-Method
        // header is never enforced on legacy notifications.
        expect(state.contexts).toHaveLength(0);
    });

    it('routes a notification POST by the modern header when the body carries no claim', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });

        const response = await handler.fetch(
            postRequest(
                { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
                { 'mcp-protocol-version': MODERN_REVISION }
            )
        );
        expect(response.status).toBe(202);
        expect(state.contexts).toHaveLength(1);
        expect(state.contexts[0]?.era).toBe('modern');
    });

    it('names the modern revisions in the strict rejection data so legacy clients can discover the endpoint era', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'reject' });
        const response = await handler.fetch(postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
        const body = (await response.json()) as JSONRPCErrorBody;
        // The strict rejection deliberately names the modern revisions so a legacy
        // client can discover what the endpoint serves from the error alone.
        expect(JSON.stringify(body.error.data)).toContain(MODERN_REVISION);
    });
});

describe('createMcpHandler — stateless legacy fallback (the default)', () => {
    it('serves a 2025-era client by default through the frozen stateless idiom with a fresh instance per request', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const initialize = await handler.fetch(
            postRequest({
                jsonrpc: '2.0',
                id: 'init-1',
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', clientInfo: { name: 'legacy-client', version: '1.0' }, capabilities: {} }
            })
        );
        expect(initialize.status).toBe(200);
        expect(await initialize.text()).toContain('"protocolVersion":"2025-11-25"');

        const toolsCall = await handler.fetch(
            postRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'legacy hello' } } })
        );
        expect(toolsCall.status).toBe(200);
        expect(await toolsCall.text()).toContain('legacy hello');

        expect(state.contexts).toHaveLength(2);
        expect(state.contexts.every(ctx => ctx.era === 'legacy')).toBe(true);
        expect(state.products[0]).not.toBe(state.products[1]);
        // Hand-shaped legacy serving never marks instances as modern.
        expect(state.products[0]!.server.getNegotiatedProtocolVersion()).not.toBe(MODERN_REVISION);
    });

    it("serves the same legacy traffic when 'stateless' is passed explicitly (the explicit value of the default)", async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory, { legacy: 'stateless' });

        const initialize = await handler.fetch(
            postRequest({
                jsonrpc: '2.0',
                id: 'init-2',
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', clientInfo: { name: 'legacy-client', version: '1.0' }, capabilities: {} }
            })
        );
        expect(initialize.status).toBe(200);
        expect(await initialize.text()).toContain('"protocolVersion":"2025-11-25"');
        expect(state.contexts[0]?.era).toBe('legacy');
    });

    it('answers GET and DELETE like the canonical stateless example (405, Method not allowed.)', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        for (const method of ['GET', 'DELETE']) {
            const response = await handler.fetch(new Request('http://localhost/mcp', { method }));
            expect(response.status).toBe(405);
            const body = (await response.json()) as JSONRPCErrorBody;
            expect(body.error.code).toBe(-32_000);
            expect(body.error.message).toBe('Method not allowed.');
        }
    });

    it('routes legacy notification POSTs to the legacy leg (202 acknowledged by the stateless transport)', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(postRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        expect(response.status).toBe(202);
        expect(state.contexts).toHaveLength(1);
        expect(state.contexts[0]?.era).toBe('legacy');
    });

    it('routes all-legacy batch arrays to the legacy leg unchanged', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(
            postRequest([
                { jsonrpc: '2.0', method: 'notifications/initialized' },
                { jsonrpc: '2.0', method: 'notifications/roots/list_changed' }
            ])
        );
        expect(response.status).toBe(202);
    });

    it('hands unparseable bodies to the legacy leg so the parse error stays the legacy transport answer', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(postRequest('{not json'));
        expect(response.status).toBe(400);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_700);
    });

    it('still serves the modern path on the same endpoint (one factory, both legs)', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        const modern = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'modern hello' })));
        expect(modern.status).toBe(200);
        expect(await modern.text()).toContain('modern hello');
        expect(state.contexts[0]?.era).toBe('modern');
    });

    it("reports legacy-leg failures through the entry's onerror instead of swallowing them", async () => {
        const onerror = vi.fn();
        const handler = createMcpHandler(
            ctx => {
                if (ctx.era === 'legacy') {
                    throw new Error('legacy factory exploded');
                }
                return new McpServer({ name: 'modern-only-product', version: '1.0.0' });
            },
            { onerror }
        );

        const response = await handler.fetch(postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
        expect(response.status).toBe(500);
        expect(((await response.json()) as JSONRPCErrorBody).error.code).toBe(-32_603);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'legacy factory exploded' }));
    });

    it('keeps classifier rejections authoritative on the dual arm (pins the current -32600 cells with the fallback active)', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        // Parsed-but-not-JSON-RPC single object: the entry's -32600, not the
        // legacy transport's -32700.
        const notJsonRpc = await handler.fetch(postRequest({ hello: 'world' }));
        expect(notJsonRpc.status).toBe(400);
        expect(((await notJsonRpc.json()) as JSONRPCErrorBody).error.code).toBe(-32_600);

        // Empty batch: the entry's -32600/400, not the legacy leg's 202 ack.
        const emptyBatch = await handler.fetch(postRequest([]));
        expect(emptyBatch.status).toBe(400);
        expect(((await emptyBatch.json()) as JSONRPCErrorBody).error.code).toBe(-32_600);

        // A batch containing an invalid element is rejected on both arms (element-wise classification).
        const mixedBatch = await handler.fetch(postRequest([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { nope: true }]));
        expect(mixedBatch.status).toBe(400);
        expect(((await mixedBatch.json()) as JSONRPCErrorBody).error.code).toBe(-32_600);

        // The legacy leg is never consulted for these cells.
        expect(state.contexts).toHaveLength(0);
    });

    it('answers a legacy-direction server/discover with a plain method-not-found and zero 2026 vocabulary', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(postRequest({ jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} }));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('-32601');
        expect(text).toContain('Method not found');
        expect(text).not.toContain('2026');
    });
});

describe('createMcpHandler — user-land routing with isLegacyRequest (replaces the handler-valued legacy option)', () => {
    it('routes legacy traffic to an existing handler with the original bytes untouched, alongside a strict modern entry', async () => {
        const { factory, state } = testFactory();
        const original = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
        let receivedBody: string | undefined;
        const existingLegacyHandler = vi.fn(async (request: Request) => {
            receivedBody = await request.text();
            return new Response('legacy-served', { status: 299 });
        });
        const modern = createMcpHandler(factory, { legacy: 'reject' });
        // The documented routing pattern: the predicate decides, the strict
        // entry serves everything that is not legacy.
        const route = async (request: Request): Promise<Response> => {
            if (await isLegacyRequest(request)) {
                return existingLegacyHandler(request);
            }
            return modern.fetch(request);
        };

        // A claim-less 2025 request reaches the existing handler with its body
        // still readable — the predicate classifies a clone, never the original.
        const response = await route(postRequest(original));
        expect(response.status).toBe(299);
        expect(await response.text()).toBe('legacy-served');
        expect(receivedBody).toBe(JSON.stringify(original));

        // GET/DELETE are method-routed to the existing handler too (sessionful wirings own them).
        const get = await route(new Request('http://localhost/mcp', { method: 'GET' }));
        expect(get.status).toBe(299);

        // Modern envelope traffic never reaches the legacy handler.
        const modernResponse = await route(postRequest(modernToolsCall('echo', { text: 'hi' })));
        expect(modernResponse.status).toBe(200);
        expect(existingLegacyHandler).toHaveBeenCalledTimes(2);
        expect(state.contexts.filter(ctx => ctx.era === 'modern')).toHaveLength(1);

        // A malformed modern claim is NOT legacy: it goes to the modern entry,
        // which answers the validation-ladder error (-32602), never the legacy handler.
        const malformed = await route(
            postRequest(modernToolsCall('echo', { text: 'x' }, { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION }))
        );
        expect(malformed.status).toBe(400);
        expect(((await malformed.json()) as JSONRPCErrorBody).error.code).toBe(-32_602);
        expect(existingLegacyHandler).toHaveBeenCalledTimes(2);
    });

    it('isLegacyRequest agrees with the entry classification rung across the routing cells', async () => {
        const legacyShaped: Array<{ name: string; request: () => Request }> = [
            {
                name: 'claim-less request',
                request: () => postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
            },
            {
                name: 'initialize handshake',
                request: () =>
                    postRequest({
                        jsonrpc: '2.0',
                        id: 'init-1',
                        method: 'initialize',
                        params: { protocolVersion: '2025-11-25', clientInfo: { name: 'legacy', version: '1.0' }, capabilities: {} }
                    })
            },
            { name: 'claim-less notification', request: () => postRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }) },
            { name: 'GET session operation', request: () => new Request('http://localhost/mcp', { method: 'GET' }) },
            { name: 'DELETE session operation', request: () => new Request('http://localhost/mcp', { method: 'DELETE' }) },
            {
                name: 'all-legacy batch array',
                request: () => postRequest([{ jsonrpc: '2.0', method: 'notifications/initialized' }])
            },
            { name: 'posted JSON-RPC response', request: () => postRequest({ jsonrpc: '2.0', id: 9, result: { ok: true } }) },
            { name: 'unparseable body', request: () => postRequest('{not json') },
            {
                name: 'claim-less server/discover (no envelope, classified like any other claim-less request)',
                request: () => postRequest({ jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} })
            }
        ];
        const modernShaped: Array<{ name: string; request: () => Request }> = [
            { name: 'valid modern envelope', request: () => postRequest(modernToolsCall('echo', { text: 'x' })) },
            {
                name: 'enveloped server/discover probe',
                request: () => postRequest({ jsonrpc: '2.0', id: 5, method: 'server/discover', params: { _meta: ENVELOPE } })
            },
            {
                name: 'envelope claiming an unsupported revision (modern path answers -32004)',
                request: () =>
                    postRequest(modernToolsCall('echo', { text: 'x' }, { ...ENVELOPE, [PROTOCOL_VERSION_META_KEY]: '2030-01-01' }))
            },
            {
                name: 'malformed envelope behind a present claim (modern path answers -32602)',
                request: () => postRequest(modernToolsCall('echo', { text: 'x' }, { [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION }))
            },
            {
                name: 'modern header without a claim (modern path answers -32602)',
                request: () =>
                    postRequest(
                        { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} },
                        { 'mcp-protocol-version': MODERN_REVISION, 'mcp-method': 'tools/list' }
                    )
            },
            {
                name: 'header/body mismatch (modern path answers -32001)',
                request: () => postRequest(modernToolsCall('echo', { text: 'x' }), { 'mcp-protocol-version': '2025-11-25' })
            }
        ];

        for (const { name, request } of legacyShaped) {
            expect(await isLegacyRequest(request()), name).toBe(true);
        }
        for (const { name, request } of modernShaped) {
            expect(await isLegacyRequest(request()), name).toBe(false);
        }
    });

    it('leaves the request body readable and accepts a pre-parsed body without reading the stream', async () => {
        const original = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} };

        // Body stays readable after the predicate ran (it classified a clone).
        const request = postRequest(original);
        expect(await isLegacyRequest(request)).toBe(true);
        expect(request.bodyUsed).toBe(false);
        expect(await request.text()).toBe(JSON.stringify(original));

        // With a pre-parsed body the request stream is never touched at all.
        const preParsed = postRequest(original);
        expect(await isLegacyRequest(preParsed, original)).toBe(true);
        expect(preParsed.bodyUsed).toBe(false);
        expect(await isLegacyRequest(postRequest(modernToolsCall('echo', { text: 'x' })), modernToolsCall('echo', { text: 'x' }))).toBe(
            false
        );
    });

    it("throws a TypeError at construction when a handler function is passed as the 'legacy' option", () => {
        const { factory } = testFactory();
        const myExistingLegacyHandler = async (): Promise<Response> => new Response(null, { status: 200 });
        const construct = () => createMcpHandler(factory, { legacy: myExistingLegacyHandler as unknown as 'stateless' });
        expect(construct).toThrow(TypeError);
        expect(construct).toThrow(/isLegacyRequest/);
    });
});

describe('createMcpHandler — responseMode', () => {
    it('defaults to the lazy upgrade: a handler emitting a related notification streams the exchange over SSE', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const response = await handler.fetch(postRequest(modernToolsCall('progress-then-echo', { text: 'streamed' })));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const text = await response.text();
        expect(text).toContain('notifications/progress');
        expect(text).toContain('streamed');
    });

    it("responseMode: 'json' never streams and drops mid-call notifications", async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { responseMode: 'json' });

        const response = await handler.fetch(postRequest(modernToolsCall('progress-then-echo', { text: 'json only' })));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const text = await response.text();
        expect(text).not.toContain('notifications/progress');
        expect(text).toContain('json only');
    });

    it("responseMode: 'sse' streams even when the handler emits nothing before its result", async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory, { responseMode: 'sse' });

        const response = await handler.fetch(postRequest(modernToolsCall('echo', { text: 'eager stream' })));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(await response.text()).toContain('eager stream');
    });
});

describe('createMcpHandler — handler faces', () => {
    it('exposes a detach-safe fetch face', async () => {
        const { factory } = testFactory();
        const { fetch: detachedFetch } = createMcpHandler(factory);
        const response = await detachedFetch(postRequest(modernToolsCall('echo', { text: 'detached' })));
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('detached');
    });

    it('serves through the duck-typed node face, reading the request stream when no parsed body is given', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const { req, res, body } = nodeRequestResponse(modernToolsCall('echo', { text: 'node face' }));
        // Express mounts pass `next` as the third argument; a function is never a parsed body.
        await handler.node(req, res, () => {});
        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('node face');
    });

    it('prefers a pre-parsed body over the request stream on the node face', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const parsed = modernToolsCall('echo', { text: 'pre-parsed' });
        const { req, res, body } = nodeRequestResponse(undefined);
        Object.assign(req.headers, bodyDerivedStandardHeaders(parsed));
        await handler.node(req, res, parsed);
        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('pre-parsed');
    });

    it('serves a pre-parsed legacy body through the node face on the default fallback (the documented express.json mounting)', async () => {
        const { factory, state } = testFactory();
        const handler = createMcpHandler(factory);

        // The documented Express mounting: express.json() consumed the stream
        // and hands the parsed object as the third argument; the raw headers
        // still describe the original (already-consumed) bytes.
        const legacyMessage = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'node legacy' } } };
        const { req, res, body } = nodeRequestResponse(undefined);
        req.headers['content-length'] = '999';
        req.headers['transfer-encoding'] = 'chunked';
        await handler.node(req, res, legacyMessage);

        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('node legacy');
        expect(state.contexts).toHaveLength(1);
        expect(state.contexts[0]?.era).toBe('legacy');
    });

    it('forwards req.auth from upstream middleware as pass-through authInfo on the node face', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const { req, res, body } = nodeRequestResponse(modernToolsCall('whoami', {}));
        req.auth = { token: 'verified', clientId: 'node-client', scopes: [] };
        await handler.node(req, res);
        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('node-client');
    });

    it('skips HTTP/2 pseudo-headers when copying node request headers', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const { req, res, body } = nodeRequestResponse(modernToolsCall('echo', { text: 'http2 served' }));
        Object.assign(req.headers, {
            ':method': 'POST',
            ':path': '/mcp',
            ':scheme': 'http',
            ':authority': 'localhost:3000'
        });
        await handler.node(req, res);

        expect(res.statusCode).toBe(200);
        expect(await body()).toContain('http2 served');
    });

    it('waits for drain before writing the next chunk when res.write reports backpressure', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const writes: string[] = [];
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const res: NodeServerResponseLike & { statusCode: number } = {
            statusCode: 0,
            writeHead(statusCode: number) {
                this.statusCode = statusCode;
                return this;
            },
            write(chunk: string | Uint8Array) {
                writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
                // Always report a full buffer.
                return false;
            },
            end() {
                return this;
            },
            on(event: string, listener: (...args: unknown[]) => void) {
                const existing = listeners.get(event) ?? [];
                existing.push(listener);
                listeners.set(event, existing);
                return this;
            }
        };
        const emitDrain = () => {
            for (const listener of listeners.get('drain') ?? []) {
                listener();
            }
        };

        // The default (auto) response mode streams this exchange over SSE, so
        // the loop sees at least two chunks (the progress frame and the result).
        const { req } = nodeRequestResponse(modernToolsCall('progress-then-echo', { text: 'paced' }));
        const served = handler.node(req, res);

        await vi.waitFor(() => expect(writes.length).toBe(1));
        // With the buffer reported full and no drain yet, no further chunk is written.
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(writes).toHaveLength(1);

        // Draining releases the loop chunk by chunk until the stream completes.
        const pump = setInterval(emitDrain, 5);
        await served;
        clearInterval(pump);

        const streamed = writes.join('');
        expect(writes.length).toBeGreaterThan(1);
        expect(streamed).toContain('notifications/progress');
        expect(streamed).toContain('paced');
    });
});

describe('createMcpHandler — close()', () => {
    it('aborts in-flight modern exchanges and refuses further requests', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);

        const pending = handler.fetch(postRequest(modernToolsCall('park', {})));
        // Give the exchange time to reach the parked handler before tearing down.
        await new Promise(resolve => setTimeout(resolve, 50));
        await handler.close();

        const response = await pending;
        expect(response.status).toBe(499);

        await expect(handler.fetch(postRequest(modernToolsCall('echo', { text: 'late' })))).rejects.toThrow(/closed/);
    });

    it('leaves the legacy fallback untouched by close() until the handler itself refuses requests', async () => {
        const { factory } = testFactory();
        const handler = createMcpHandler(factory);
        await handler.close();
        await expect(handler.fetch(postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))).rejects.toThrow(/closed/);
    });
});

/* ------------------------------------------------------------------------ *
 * Node face fixtures (duck-typed, no real sockets)
 * ------------------------------------------------------------------------ */

interface FakeNodeResponse extends NodeServerResponseLike {
    statusCode: number;
    headers: Record<string, string> | undefined;
}

function nodeRequestResponse(body: unknown): {
    req: Readable & {
        method: string;
        url: string;
        headers: Record<string, string>;
        auth?: { token: string; clientId: string; scopes: string[] };
    };
    res: FakeNodeResponse;
    body: () => Promise<string>;
} {
    const payload = body === undefined ? [] : [JSON.stringify(body)];
    const req = Object.assign(Readable.from(payload), {
        method: 'POST',
        url: '/mcp',
        headers: {
            host: 'localhost:3000',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...bodyDerivedStandardHeaders(body)
        } as Record<string, string>
    });

    const chunks: string[] = [];
    let resolveFinished: () => void;
    const finished = new Promise<void>(resolve => {
        resolveFinished = resolve;
    });
    const res: FakeNodeResponse = {
        statusCode: 0,
        headers: undefined,
        writeHead(statusCode: number, headers?: Record<string, string>) {
            this.statusCode = statusCode;
            this.headers = headers;
            return this;
        },
        write(chunk: string | Uint8Array) {
            chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
            return true;
        },
        end(chunk?: string | Uint8Array) {
            if (chunk !== undefined) {
                this.write(chunk);
            }
            resolveFinished();
            return this;
        },
        on() {
            return this;
        }
    };

    return {
        req,
        res,
        body: async () => {
            await finished;
            return chunks.join('');
        }
    };
}

// Type-level pin: a zero-argument factory stays assignable to McpServerFactory unchanged.
const zeroArgFactory = () => new McpServer({ name: 'zero-arg', version: '1.0.0' });
void createMcpHandler(zeroArgFactory);
