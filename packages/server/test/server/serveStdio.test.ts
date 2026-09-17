/**
 * `serveStdio` — the connection-pinned stdio entry:
 *
 * - the opening exchange selects the era exactly once; ONE factory instance
 *   is pinned for the connection lifetime and serves only that era;
 * - a legacy opening (`initialize`, or any claim-less message) pins a 2025
 *   instance that serves the session exactly as a hand-wired stdio server
 *   does today (zero 2026 vocabulary on the wire — the per-connection leak
 *   test);
 * - a valid modern envelope opening pins a 2026-07-28 instance (era-written
 *   by the entry, modern-only handlers installed);
 * - a `server/discover` probe is answered without pinning; the next message
 *   either pins the modern era or falls back to a fresh legacy instance
 *   (probe instance discarded) when the client returns to `initialize`;
 * - once the modern era is pinned, a late claim-less `initialize` is answered
 *   with the unsupported-protocol-version error naming the supported
 *   revisions;
 * - `legacy: 'reject'` answers legacy openings with the same error and never
 *   pins a legacy instance;
 * - malformed and unsupported envelope claims are answered by the entry,
 *   consistent with the HTTP entry's treatment, without pinning.
 */
import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    MessageExtraInfo,
    Transport
} from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    inputRequired,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { McpServerFactory } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';
import type { ServeStdioOptions } from '../../src/server/serveStdio';
import { serveStdio } from '../../src/server/serveStdio';

const MODERN = '2026-07-28';

/** 2026-era vocabulary that must never leak onto a connection pinned to the 2025 era. */
const FORBIDDEN_2026_VOCABULARY = ['2026', 'discover', 'envelope', 'modern', 'era', 'resultType', 'io.modelcontextprotocol'];

const envelope = (overrides?: Record<string, unknown>) => ({
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'serve-stdio-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides
});

const initializeRequest = (id: number | string, requestedVersion = LATEST_PROTOCOL_VERSION): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
        protocolVersion: requestedVersion,
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '1.0.0' }
    }
});

/** A factory that records every construction (era + product) and registers one echo tool. */
function trackingFactory() {
    const eras: Array<'legacy' | 'modern'> = [];
    const closed: boolean[] = [];
    const factory = (ctx: { era: 'legacy' | 'modern' }) => {
        const index = eras.length;
        eras.push(ctx.era);
        closed.push(false);
        const server = new McpServer(
            { name: 'serve-stdio-test-server', version: '1.0.0' },
            { capabilities: { tools: {} }, instructions: 'serve-stdio test instructions' }
        );
        server.registerTool('echo', { description: 'Echoes the input text', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        server.server.onclose = () => {
            closed[index] = true;
        };
        return server;
    };
    return { factory, eras, closed };
}

/** Boots the entry on one side of an in-memory pair with the given factory and returns raw drivers for the peer side. */
async function startEntryWith(factory: McpServerFactory, options?: Omit<ServeStdioOptions, 'transport'>) {
    const [peerTx, wireTx] = InMemoryTransport.createLinkedPair();

    const inbound: JSONRPCMessage[] = [];
    const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
    peerTx.onmessage = message => {
        inbound.push(message);
        const id = (message as { id?: string | number }).id;
        const waiter = id === undefined ? undefined : waiters.get(id);
        if (id !== undefined && waiter) {
            waiters.delete(id);
            waiter(message);
        }
    };
    await peerTx.start();

    const errors: Error[] = [];
    const handle = serveStdio(factory, { transport: wireTx, onerror: error => void errors.push(error), ...options });

    const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
        new Promise(resolve => {
            waiters.set(message.id, resolve);
            void peerTx.send(message);
        });
    const notify = (message: JSONRPCNotification): Promise<void> => peerTx.send(message);
    const flush = () => new Promise(resolve => setTimeout(resolve, 20));

    return { handle, request, notify, flush, inbound, errors, peerTx };
}

/** Boots the entry with a fresh tracking factory (the default harness for most tests). */
async function startEntry(options?: Omit<ServeStdioOptions, 'transport'>) {
    const { factory, eras, closed } = trackingFactory();
    return { ...(await startEntryWith(factory, options)), eras, closed };
}

describe('legacy opening (default legacy: serve)', () => {
    it('pins one 2025-era instance for the connection and serves it exactly like a hand-wired stdio server', async () => {
        const { handle, request, notify, inbound, eras } = await startEntry();

        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect(init.result).toEqual({
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: 'serve-stdio-test-server', version: '1.0.0' },
                instructions: 'serve-stdio test instructions'
            });
        }
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        if (isJSONRPCResultResponse(list)) {
            expect((list.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toEqual(['echo']);
            expect(Object.keys(list.result as Record<string, unknown>).sort()).toEqual(['tools']);
        }

        const call = await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
        expect(isJSONRPCResultResponse(call)).toBe(true);
        if (isJSONRPCResultResponse(call)) {
            expect(call.result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
        }

        // The era decision happened exactly once: one legacy instance, no probe instance.
        expect(eras).toEqual(['legacy']);

        // Per-connection leak test: a claim-less server/discover on this
        // 2025-pinned connection answers the same plain -32601 a deployed 2025
        // server answers, with zero 2026 vocabulary anywhere in the response.
        const gate = await request({ jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} });
        expect(isJSONRPCErrorResponse(gate)).toBe(true);
        if (isJSONRPCErrorResponse(gate)) {
            expect(gate.error).toEqual({ code: -32_601, message: 'Method not found' });
        }

        // Nothing the entry or the instance wrote on this connection carries 2026 wire vocabulary.
        const wireBytes = JSON.stringify(inbound).toLowerCase();
        for (const term of FORBIDDEN_2026_VOCABULARY) {
            expect(wireBytes).not.toContain(term.toLowerCase());
        }

        await handle.close();
    });

    it('a claim-less non-initialize opening also pins the legacy era', async () => {
        const { handle, request, eras } = await startEntry();

        const list = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        expect(eras).toEqual(['legacy']);

        await handle.close();
    });
});

describe('modern opening', () => {
    it('a valid enveloped request pins one era-written 2026-07-28 instance', async () => {
        const { handle, request, eras } = await startEntry();

        const list = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        if (isJSONRPCResultResponse(list)) {
            const result = list.result as { tools: Array<{ name: string }>; resultType?: string };
            expect(result.tools.map(tool => tool.name)).toEqual(['echo']);
            expect(result.resultType).toBe('complete');
        }
        expect(eras).toEqual(['modern']);

        const call = await request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'modern leg' }, _meta: envelope() }
        });
        expect(isJSONRPCResultResponse(call)).toBe(true);
        if (isJSONRPCResultResponse(call)) {
            expect((call.result as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'modern leg' }]);
        }

        await handle.close();
    });

    it('an enveloped initialize is classified by its valid modern claim and answered with a plain -32601', async () => {
        const { handle, request, eras } = await startEntry();

        const response = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: envelope() } });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_601);
            expect(response.error.message).toBe('Method not found');
            expect(response.error.data).toBeUndefined();
        }
        expect(eras).toEqual(['modern']);

        await handle.close();
    });

    it('once the modern era is pinned, a late claim-less initialize answers -32022 naming the supported revisions', async () => {
        const { handle, request } = await startEntry();

        const list = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(list)).toBe(true);

        const init = await request(initializeRequest(2));
        expect(isJSONRPCErrorResponse(init)).toBe(true);
        if (isJSONRPCErrorResponse(init)) {
            expect(init.error.code).toBe(-32_022);
            const data = init.error.data as { supported?: string[]; requested?: string };
            expect(data.supported).toContain(MODERN);
            expect(data.requested).toBe(LATEST_PROTOCOL_VERSION);
        }

        await handle.close();
    });
});

describe('server/discover probe window', () => {
    it('answers the probe from an optimistically built modern instance and pins modern when the client continues with the envelope', async () => {
        const { handle, request, eras } = await startEntry();

        const discover = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(discover)).toBe(true);
        if (isJSONRPCResultResponse(discover)) {
            const result = discover.result as { supportedVersions?: string[]; resultType?: string };
            expect(result.supportedVersions).toEqual([MODERN]);
            expect(result.resultType).toBe('complete');
        }

        const call = await request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'after probe' }, _meta: envelope() }
        });
        expect(isJSONRPCResultResponse(call)).toBe(true);
        if (isJSONRPCResultResponse(call)) {
            expect((call.result as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'after probe' }]);
        }

        // The probe instance IS the pinned instance: the factory ran once.
        expect(eras).toEqual(['modern']);

        await handle.close();
    });

    it('discover followed by initialize falls back to a fresh legacy instance and discards the probe instance', async () => {
        const { handle, request, eras, closed } = await startEntry();

        const discover = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(discover)).toBe(true);

        // The client found no mutually supported modern revision and falls
        // back to the 2025 handshake on the same connection.
        const init = await request(initializeRequest(2));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        }

        // The optimistic modern instance was discarded; the legacy session is
        // served end to end by the second (legacy) instance.
        expect(eras).toEqual(['modern', 'legacy']);
        expect(closed[0]).toBe(true);
        expect(closed[1]).toBe(false);

        const list = await request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        if (isJSONRPCResultResponse(list)) {
            expect(JSON.stringify(list)).not.toContain('resultType');
        }

        await handle.close();
    });

    it('answers the probe even when the fallback initialize is pipelined immediately behind it', async () => {
        const { handle, request, flush, inbound, errors, eras } = await startEntry();

        // The client does not wait for the DiscoverResult before falling back:
        // both messages are on the wire back to back. The probe must still be
        // answered (never silently dropped) and the legacy session served.
        const discoverPromise = request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        const initPromise = request(initializeRequest(2));

        const [discover, init] = await Promise.all([discoverPromise, initPromise]);
        expect(isJSONRPCResultResponse(discover)).toBe(true);
        if (isJSONRPCResultResponse(discover)) {
            expect((discover.result as { supportedVersions?: string[] }).supportedVersions).toEqual([MODERN]);
        }
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        }
        // The probe answer reached the wire before the fallback's handshake answer.
        expect(inbound.indexOf(discover)).toBeLessThan(inbound.indexOf(init));
        expect(eras).toEqual(['modern', 'legacy']);

        // The legacy session continues normally and nothing was dropped or reported.
        const list = await request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        await flush();
        expect(errors).toEqual([]);

        await handle.close();
    });

    it('a repeated server/discover probe is answered by the same probe instance and a later initialize still falls back to legacy', async () => {
        const { handle, request, eras, closed } = await startEntry();

        const first = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(first)).toBe(true);

        const second = await request({ jsonrpc: '2.0', id: 'probe-2', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(second)).toBe(true);
        if (isJSONRPCResultResponse(second)) {
            expect((second.result as { supportedVersions?: string[] }).supportedVersions).toEqual([MODERN]);
        }

        // Both probes were answered by the single optimistic instance; the
        // connection is still inside the negotiation window.
        expect(eras).toEqual(['modern']);

        // The fallback handshake is still served by a fresh legacy instance.
        const init = await request(initializeRequest(3));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        }
        expect(eras).toEqual(['modern', 'legacy']);
        expect(closed[0]).toBe(true);
        expect(closed[1]).toBe(false);

        await handle.close();
    });

    it('an enveloped notification during the probe window does not pin the era and a later initialize still falls back to legacy', async () => {
        const { handle, request, notify, flush, eras, closed, errors } = await startEntry();

        const discover = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(discover)).toBe(true);

        // The client cancels its probe (for example on a local timeout) with
        // an enveloped notification before falling back to the 2025
        // handshake. The notification is delivered to the probe instance but
        // does not commit the connection to the modern era.
        await notify({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 'probe-1', reason: 'probe timed out', _meta: envelope() }
        });
        await flush();

        const init = await request(initializeRequest(2));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        }

        // The fallback handshake was served by a fresh legacy instance and
        // the probe instance was discarded; nothing was reported as dropped.
        expect(eras).toEqual(['modern', 'legacy']);
        expect(closed[0]).toBe(true);
        expect(closed[1]).toBe(false);
        expect(errors).toEqual([]);

        await handle.close();
    });

    it('a pipelined cancellation of the probe followed by initialize still falls back to a working legacy session', async () => {
        const { handle, request, notify, flush, eras, closed, errors } = await startEntry();

        // The client pipelines all three messages without waiting for any
        // answer: the probe, an enveloped cancellation naming the probe id
        // (which aborts the in-flight discover handler, so the probe may
        // legitimately never be answered), and the fallback 2025 handshake.
        // The cancelled probe must not hold the connection: the handshake is
        // answered and the legacy session is fully usable.
        void request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        void notify({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 'probe-1', reason: 'negotiation aborted', _meta: envelope() }
        });
        const init = await request(initializeRequest(2));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        }

        // The probe instance was discarded and the fallback is served end to
        // end by a fresh legacy instance.
        expect(eras).toEqual(['modern', 'legacy']);
        expect(closed[0]).toBe(true);
        expect(closed[1]).toBe(false);

        const list = await request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        await flush();
        expect(errors).toEqual([]);

        await handle.close();
    });

    it('an enveloped non-discover request after the probe still pins the modern era', async () => {
        const { handle, request, eras } = await startEntry();

        const discover = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(discover)).toBe(true);

        const call = await request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'commit' }, _meta: envelope() }
        });
        expect(isJSONRPCResultResponse(call)).toBe(true);

        // The enveloped request committed the connection: a later claim-less
        // initialize is rejected instead of falling back to a legacy instance.
        const init = await request(initializeRequest(3));
        expect(isJSONRPCErrorResponse(init)).toBe(true);
        if (isJSONRPCErrorResponse(init)) {
            expect(init.error.code).toBe(-32_022);
        }
        // The probe instance is the pinned instance: the factory ran exactly once.
        expect(eras).toEqual(['modern']);

        await handle.close();
    });

    it('a repeated server/discover probe followed by an enveloped request pins the modern era', async () => {
        const { handle, request, eras } = await startEntry();

        const first = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(first)).toBe(true);

        const second = await request({ jsonrpc: '2.0', id: 'probe-2', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(second)).toBe(true);

        const call = await request({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'after repeated probe' }, _meta: envelope() }
        });
        expect(isJSONRPCResultResponse(call)).toBe(true);
        if (isJSONRPCResultResponse(call)) {
            expect((call.result as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'after repeated probe' }]);
        }

        // The probe instance is the pinned instance: the factory ran exactly once.
        expect(eras).toEqual(['modern']);

        await handle.close();
    });
});

describe("legacy: 'reject'", () => {
    it('answers a legacy opening with -32022 naming the supported modern revisions and never pins a legacy instance', async () => {
        const { handle, request, eras } = await startEntry({ legacy: 'reject' });

        const init = await request(initializeRequest(1));
        expect(isJSONRPCErrorResponse(init)).toBe(true);
        if (isJSONRPCErrorResponse(init)) {
            expect(init.error.code).toBe(-32_022);
            const data = init.error.data as { supported?: string[]; requested?: string };
            expect(data.supported).toContain(MODERN);
            expect(data.requested).toBe(LATEST_PROTOCOL_VERSION);
        }
        expect(eras).toEqual([]);

        // A modern opening on the same connection is still served afterwards.
        const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        expect(eras).toEqual(['modern']);

        await handle.close();
    });

    it('drops a claim-less notification without a response', async () => {
        const { handle, notify, flush, inbound, eras } = await startEntry({ legacy: 'reject' });

        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await flush();

        expect(inbound).toHaveLength(0);
        expect(eras).toEqual([]);

        await handle.close();
    });
});

describe('malformed and unsupported envelope claims (entry-answered, never pinned)', () => {
    it('a present claim with a malformed envelope answers -32602 naming the envelope problem', async () => {
        const { handle, request, eras } = await startEntry();

        const response = await request({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: { _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN } }
        });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_602);
            expect(response.error.message).toContain('Invalid _meta envelope');
        }
        expect(eras).toEqual([]);

        // The connection is not pinned by the rejected opening: a valid
        // modern opening afterwards is served normally.
        const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        expect(eras).toEqual(['modern']);

        await handle.close();
    });

    it('a valid claim naming an unsupported revision answers -32022 with the supported list', async () => {
        const { handle, request, eras } = await startEntry();

        const response = await request({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: { _meta: envelope({ [PROTOCOL_VERSION_META_KEY]: '2099-01-01' }) }
        });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_022);
            const data = (response as JSONRPCErrorResponse).error.data as { supported?: string[]; requested?: string };
            expect(data.supported).toContain(MODERN);
            expect(data.requested).toBe('2099-01-01');
        }
        expect(eras).toEqual([]);

        await handle.close();
    });
});

describe('factory or connect failure during the opening exchange (entry-answered, never pinned)', () => {
    it('answers a legacy opening with -32603 when the factory throws, reports the error, and leaves the connection unpinned', async () => {
        const { factory: workingFactory, eras } = trackingFactory();
        let failures = 1;
        const factory: McpServerFactory = ctx => {
            if (failures > 0) {
                failures -= 1;
                throw new Error('factory failed to build an instance');
            }
            return workingFactory(ctx);
        };
        const { handle, request, flush, errors } = await startEntryWith(factory);

        const init = await request(initializeRequest(1));
        expect(isJSONRPCErrorResponse(init)).toBe(true);
        if (isJSONRPCErrorResponse(init)) {
            expect(init.error.code).toBe(-32_603);
            expect(init.error.message).toBe('Internal server error');
        }
        await flush();
        expect(errors.some(error => error.message.includes('factory failed to build an instance'))).toBe(true);
        expect(eras).toEqual([]);

        // The failed opening did not pin the connection: a retried handshake
        // on the same connection is served by a fresh legacy instance.
        const retry = await request(initializeRequest(2));
        expect(isJSONRPCResultResponse(retry)).toBe(true);
        expect(eras).toEqual(['legacy']);

        await handle.close();
    });

    it('answers a modern opening with -32603 when connecting the instance fails and leaves the connection unpinned', async () => {
        const { factory: workingFactory, eras } = trackingFactory();
        let failures = 1;
        const factory: McpServerFactory = ctx => {
            const product = workingFactory(ctx);
            if (failures > 0) {
                failures -= 1;
                product.connect = () => Promise.reject(new Error('instance connect failed'));
            }
            return product;
        };
        const { handle, request, flush, errors } = await startEntryWith(factory);

        const list = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCErrorResponse(list)).toBe(true);
        if (isJSONRPCErrorResponse(list)) {
            expect(list.error.code).toBe(-32_603);
            expect(list.error.message).toBe('Internal server error');
        }
        await flush();
        expect(errors.some(error => error.message.includes('instance connect failed'))).toBe(true);
        // The factory ran but nothing was pinned: the next modern opening is
        // served by a freshly connected instance.
        expect(eras).toEqual(['modern']);

        const retry = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(retry)).toBe(true);
        expect(eras).toEqual(['modern', 'modern']);

        await handle.close();
    });

    it('answers a server/discover probe with -32603 when the factory rejects and keeps the negotiation window open', async () => {
        const { factory: workingFactory, eras } = trackingFactory();
        let failures = 1;
        const factory: McpServerFactory = ctx => {
            if (failures > 0) {
                failures -= 1;
                return Promise.reject(new Error('factory failed to build an instance'));
            }
            return workingFactory(ctx);
        };
        const { handle, request, flush, errors } = await startEntryWith(factory);

        const discover = await request({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCErrorResponse(discover)).toBe(true);
        if (isJSONRPCErrorResponse(discover)) {
            expect(discover.error.code).toBe(-32_603);
            expect(discover.error.message).toBe('Internal server error');
        }
        await flush();
        expect(errors.some(error => error.message.includes('factory failed to build an instance'))).toBe(true);
        expect(eras).toEqual([]);

        // The failed probe did not pin anything: the connection is still in
        // the negotiation window and a fallback handshake is served normally.
        const init = await request(initializeRequest(2));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        expect(eras).toEqual(['legacy']);

        await handle.close();
    });
});

describe('a close racing the opening factory', () => {
    /**
     * A factory that suspends until released and exposes what happens to its
     * product afterwards: whether it was closed, and every message that is
     * delivered to it after it has been connected.
     */
    function gatedObservableFactory() {
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let entered!: () => void;
        const constructionStarted = new Promise<void>(resolve => {
            entered = resolve;
        });
        const eras: Array<'legacy' | 'modern'> = [];
        const productClosed: boolean[] = [];
        const delivered: JSONRPCMessage[] = [];
        const factory: McpServerFactory = async ctx => {
            const index = eras.length;
            eras.push(ctx.era);
            productClosed.push(false);
            entered();
            await gate;
            const server = new McpServer({ name: 'serve-stdio-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
            server.server.onclose = () => {
                productClosed[index] = true;
            };
            const realConnect = server.connect.bind(server);
            server.connect = async (transport: Transport) => {
                await realConnect(transport);
                const forward = transport.onmessage;
                transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
                    delivered.push(message);
                    forward?.(message, extra);
                };
            };
            return server;
        };
        return { factory, constructionStarted, release, eras, productClosed, delivered };
    }

    it('handle.close() during the legacy factory build stays closed: the late instance is closed and never delivered to', async () => {
        const { factory, constructionStarted, release, eras, productClosed, delivered } = gatedObservableFactory();
        const { handle, flush, inbound, peerTx } = await startEntryWith(factory);

        // The opening handshake arrives and the entry starts building the
        // legacy instance; the connection is closed while the factory is
        // still mid-construction.
        void peerTx.send(initializeRequest(1));
        await constructionStarted;
        await handle.close();

        // The factory resolves only after the connection is gone.
        release();
        await flush();

        // The connection stays closed: the late-resolved instance is closed,
        // the opening message is never delivered to it, nothing further
        // reaches the wire, and no other instance is built.
        expect(eras).toEqual(['legacy']);
        expect(productClosed).toEqual([true]);
        expect(delivered).toEqual([]);
        expect(inbound).toEqual([]);
    });

    it('handle.close() during the probe-instance build does not resurrect the negotiation window', async () => {
        const { factory, constructionStarted, release, eras, productClosed, delivered } = gatedObservableFactory();
        const { handle, flush, inbound, peerTx } = await startEntryWith(factory);

        void peerTx.send({ jsonrpc: '2.0', id: 'probe-1', method: 'server/discover', params: { _meta: envelope() } });
        await constructionStarted;
        await handle.close();

        release();
        await flush();

        expect(eras).toEqual(['modern']);
        expect(productClosed).toEqual([true]);
        expect(delivered).toEqual([]);
        expect(inbound).toEqual([]);
    });
});

describe('outbound era gate on a modern-pinned connection', () => {
    it('a handler calling ctx.mcpReq.requestSampling gets the typed era error locally, with zero sampling wire traffic', async () => {
        let observed: unknown;
        const factory: McpServerFactory = () => {
            const server = new McpServer({ name: 'serve-stdio-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
            server.registerTool('sample', { description: 'Tries to request sampling', inputSchema: z.object({}) }, async (_args, ctx) => {
                try {
                    await ctx.mcpReq.requestSampling({ messages: [], maxTokens: 1 });
                } catch (error) {
                    observed = error;
                }
                return { content: [{ type: 'text', text: 'handled locally' }] };
            });
            return server;
        };
        const { handle, request, inbound } = await startEntryWith(factory);

        const call = await request({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'sample', arguments: {}, _meta: envelope() }
        });
        expect(isJSONRPCResultResponse(call)).toBe(true);
        if (isJSONRPCResultResponse(call)) {
            expect((call.result as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'handled locally' }]);
        }

        // The outbound era gate fired locally with the typed error…
        expect(observed).toBeInstanceOf(SdkError);
        expect((observed as SdkError).code).toBe(SdkErrorCode.MethodNotSupportedByProtocolVersion);
        // …and nothing beyond the tool-call answer ever reached the wire: no
        // sampling/createMessage request was written to the client.
        expect(inbound).toEqual([call]);

        await handle.close();
    });
});

describe('teardown', () => {
    it('handle.close() closes the pinned instance and the wire transport', async () => {
        const { handle, request, closed, peerTx } = await startEntry();

        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);

        let peerClosed = false;
        peerTx.onclose = () => {
            peerClosed = true;
        };

        await handle.close();
        expect(closed[0]).toBe(true);
        expect(peerClosed).toBe(true);
    });
});

describe('legacy input_required shim through the stdio entry', () => {
    it('a write-once tool returning inputRequired() is fulfilled over the legacy-pinned connection', async () => {
        const factory = () => {
            const server = new McpServer({ name: 'shim-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
            server.registerTool('confirm-deploy', { inputSchema: z.object({}) }, async (_args, ctx) => {
                const responses = ctx.mcpReq.inputResponses as Record<string, { action?: string; content?: { ok?: boolean } }> | undefined;
                if (responses?.confirm?.content?.ok !== true) {
                    return inputRequired({
                        inputRequests: {
                            confirm: inputRequired.elicit({ message: 'OK?', requestedSchema: { type: 'object', properties: {} } })
                        }
                    });
                }
                return { content: [{ type: 'text', text: 'confirmed' }] };
            });
            return server;
        };
        const harness = await startEntryWith(factory);

        // Teach the peer side to ANSWER the server→client elicitation leg.
        const original = harness.peerTx.onmessage!;
        harness.peerTx.onmessage = (message, extra) => {
            const candidate = message as { method?: string; id?: string | number };
            if (candidate.method === 'elicitation/create' && candidate.id !== undefined) {
                void harness.peerTx.send({ jsonrpc: '2.0', id: candidate.id, result: { action: 'accept', content: { ok: true } } });
                return;
            }
            original(message, extra);
        };

        const init: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { elicitation: { form: {} } },
                clientInfo: { name: 'legacy-client', version: '1.0.0' }
            }
        };
        expect(isJSONRPCResultResponse(await harness.request(init))).toBe(true);

        const answer = await harness.request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'confirm-deploy', arguments: {} }
        });
        expect(isJSONRPCResultResponse(answer)).toBe(true);
        const result = (answer as unknown as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
        expect(result.isError).toBeUndefined();
        expect(result.content[0]!.text).toBe('confirmed');

        await harness.handle.close();
    });
});
