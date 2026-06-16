/**
 * `ServerOptions.eraSupport` — the stdio/long-lived-connection era opt-in:
 *
 * - default `'legacy'` for hand-constructed `Server`/`McpServer`: nothing
 *   2026-era is registered or advertised, and a modern revision in
 *   `supportedProtocolVersions` without the declaration is a construction-time
 *   `TypeError` (never a silent behavior change).
 * - `'dual-era'`: `server/discover` registered without any instance binding,
 *   modern revisions advertised, both eras served per message.
 * - `'modern'`: strict 2026-only — envelope-less requests (including
 *   `initialize`) answer the unsupported-protocol-version error with the
 *   supported list; legacy-classified notifications are dropped.
 * - TS-01 directionality: a modern-bound instance cannot emit server→client
 *   wire requests (typed local error); a dual-era instance serving the legacy
 *   leg still can.
 */
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { McpServer } from '../../src/server/mcp.js';
import { Server } from '../../src/server/server.js';

const MODERN = '2026-07-28';
const DUAL_ERA_VERSIONS = [MODERN, ...SUPPORTED_PROTOCOL_VERSIONS];

const envelope = (overrides?: Record<string, unknown>) => ({
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'era-test-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides
});

const initializeRequest = (id: number, requestedVersion = LATEST_PROTOCOL_VERSION): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
        protocolVersion: requestedVersion,
        capabilities: { sampling: {} },
        clientInfo: { name: 'legacy-client', version: '1.0.0' }
    }
});

interface Connectable {
    connect(transport: InstanceType<typeof InMemoryTransport>): Promise<void>;
    close(): Promise<void>;
}

/** Wires a server to one long-lived in-memory connection and returns request/notify drivers. */
async function wireServer(server: Connectable) {
    const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();
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
    await server.connect(serverTx);
    await peerTx.start();

    const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
        new Promise(resolve => {
            waiters.set(message.id, resolve);
            void peerTx.send(message);
        });
    const notify = (message: JSONRPCNotification): Promise<void> => peerTx.send(message);
    const flush = () => new Promise(resolve => setTimeout(resolve, 10));
    return { request, notify, flush, inbound, peerTx, close: () => server.close() };
}

describe('construction-time guard (default eraSupport is legacy)', () => {
    it('throws a TypeError when supportedProtocolVersions carries a modern revision on a default instance', () => {
        expect(() => new Server({ name: 't', version: '1' }, { capabilities: {}, supportedProtocolVersions: DUAL_ERA_VERSIONS })).toThrow(
            TypeError
        );
        expect(() => new Server({ name: 't', version: '1' }, { capabilities: {}, supportedProtocolVersions: DUAL_ERA_VERSIONS })).toThrow(
            /eraSupport/
        );
    });

    it('throws for McpServer too (options are forwarded)', () => {
        expect(() => new McpServer({ name: 't', version: '1' }, { supportedProtocolVersions: [MODERN] })).toThrow(TypeError);
    });

    it('does not throw when the modern revision is accompanied by a dual-era or modern declaration', () => {
        expect(
            () =>
                new Server(
                    { name: 't', version: '1' },
                    { capabilities: {}, supportedProtocolVersions: DUAL_ERA_VERSIONS, eraSupport: 'dual-era' }
                )
        ).not.toThrow();
        expect(
            () => new Server({ name: 't', version: '1' }, { capabilities: {}, supportedProtocolVersions: [MODERN], eraSupport: 'modern' })
        ).not.toThrow();
    });

    it('a default legacy-only construction stays exactly as before (no throw, no discover handler)', async () => {
        const server = new Server({ name: 't', version: '1' }, { capabilities: {} });
        const { request, close } = await wireServer(server);
        const response = await request({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_601);
        }
        await close();
    });
});

describe("DV-30: server/discover is registered only when eraSupport !== 'legacy'", () => {
    it('a dual-era server serves discover with no instance binding and advertises only modern revisions', async () => {
        const server = new Server({ name: 'dual', version: '1' }, { capabilities: { tools: {} }, eraSupport: 'dual-era' });
        const { request, close } = await wireServer(server);

        const response = await request({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(response)).toBe(true);
        if (isJSONRPCResultResponse(response)) {
            const result = response.result as { supportedVersions?: string[]; resultType?: string };
            expect(result.supportedVersions).toEqual([MODERN]);
            // Served on the modern era: the wire result carries the 2026 result discriminator.
            expect(result.resultType).toBe('complete');
        }
        await close();
    });

    it('the served modern revisions are added to the supported list without mutating the shared default constant', () => {
        const before = [...SUPPORTED_PROTOCOL_VERSIONS];
        const server = new Server({ name: 'dual', version: '1' }, { capabilities: {}, eraSupport: 'dual-era' });
        expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(before);
        expect(server).toBeDefined();
    });
});

describe("DV-31: strict 'modern' on a long-lived connection", () => {
    async function wireModernServer() {
        const server = new Server({ name: 'strict', version: '1' }, { capabilities: { tools: {} }, eraSupport: 'modern' });
        server.setRequestHandler('tools/list', () => ({ tools: [] }));
        return { server, ...(await wireServer(server)) };
    }

    it('an envelope-less non-initialize request answers −32004 with the supported list', async () => {
        const { request, close } = await wireModernServer();
        const response = await request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            // Note: this cell shares its numeric code (−32004) with the
            // still-disputed header/body mismatch family; the cell itself is
            // settled (unsupported protocol version + supported list).
            expect(response.error.code).toBe(-32_004);
            const data = response.error.data as { supported?: string[]; requested?: string };
            expect(data.supported).toContain(MODERN);
            expect(typeof data.requested).toBe('string');
        }
        await close();
    });

    it('an envelope-less initialize answers −32004 with the supported list (never a legacy handshake)', async () => {
        const { request, close } = await wireModernServer();
        const response = await request(initializeRequest(2));
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_004);
            expect((response.error.data as { supported?: string[] }).supported).toContain(MODERN);
            expect((response.error.data as { requested?: string }).requested).toBe(LATEST_PROTOCOL_VERSION);
        }
        await close();
    });

    it('a legacy-classified notification is dropped without a response', async () => {
        const { notify, flush, inbound, close } = await wireModernServer();
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await flush();
        expect(inbound).toHaveLength(0);
        await close();
    });

    it('an enveloped modern request is served', async () => {
        const { request, close } = await wireModernServer();
        const response = await request({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(response)).toBe(true);
        if (isJSONRPCResultResponse(response)) {
            expect((response.result as { tools?: unknown[] }).tools).toEqual([]);
            expect((response.result as { resultType?: string }).resultType).toBe('complete');
        }
        await close();
    });
});

describe('TS-01 directionality (era-keyed direction enforcement)', () => {
    it('a strict-modern instance cannot emit server→client wire requests: typed local error, nothing reaches the transport', async () => {
        const server = new Server({ name: 'strict', version: '1' }, { capabilities: {}, eraSupport: 'modern' });
        const { inbound, flush, close } = await wireServer(server);

        await expect(
            server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 1 })
        ).rejects.toThrow(/not supported by the negotiated protocol version/);
        await flush();
        expect(inbound).toHaveLength(0);
        await close();
    });

    it('a dual-era instance serving the legacy leg still emits server→client requests (permitted per the message era)', async () => {
        const server = new Server({ name: 'dual', version: '1' }, { capabilities: {}, eraSupport: 'dual-era' });
        const { request, inbound, flush, close } = await wireServer(server);

        // Legacy leg: the 2025 client initializes and declares sampling support.
        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);

        // The server-initiated sampling request is legal on the legacy leg and reaches the wire.
        const pending = server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 1 });
        pending.catch(() => {
            // The peer never answers; the request is torn down with the connection below.
        });
        await flush();
        expect(inbound.some(message => (message as JSONRPCRequest).method === 'sampling/createMessage')).toBe(true);
        await close();
    });
});

describe('accessor split on long-lived dual-era instances', () => {
    it('getClientCapabilities/getClientVersion/getNegotiatedProtocolVersion keep initialize-scoped semantics; modern envelopes never backfill them', async () => {
        const server = new Server({ name: 'dual', version: '1' }, { capabilities: { tools: {} }, eraSupport: 'dual-era' });
        server.setRequestHandler('tools/list', () => ({ tools: [] }));
        const { request, close } = await wireServer(server);

        // Legacy handshake populates the initialize-scoped accessors.
        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        expect(server.getClientVersion()).toEqual({ name: 'legacy-client', version: '1.0.0' });
        expect(server.getClientCapabilities()).toEqual({ sampling: {} });
        expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

        // A modern message carrying a different client identity in its envelope
        // is served, but never backfills the instance-level accessors (per-message
        // identity is read from the per-request context, not instance state).
        const modern = await request({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {
                _meta: envelope({ [CLIENT_INFO_META_KEY]: { name: 'modern-client', version: '9.9.9' } })
            }
        });
        expect(isJSONRPCResultResponse(modern)).toBe(true);
        expect(server.getClientVersion()).toEqual({ name: 'legacy-client', version: '1.0.0' });
        expect(server.getClientCapabilities()).toEqual({ sampling: {} });
        expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

        await close();
    });
});
