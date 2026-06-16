/**
 * Long-lived dual-era serving (`eraSupport: 'dual-era'`) on one connection:
 *
 * - the legacy vertical (initialize → tools/list → tools/call) is served
 *   exactly as a 2025 server serves it (no 2026 wire fields anywhere);
 * - the modern vertical (server/discover → tools/list → tools/call, every
 *   request carrying the per-request `_meta` envelope) is served on the
 *   2026 era on the SAME connection;
 * - the long-lived era gate: a message classified into the legacy era asking
 *   for `server/discover`, `subscriptions/listen`, or any 2026-only method is
 *   answered with a plain −32601 carrying ZERO 2026 vocabulary in message or
 *   data (the dedicated leak test — the gate is not structural on a long-lived
 *   instance, which hosts both registries); the modern-direction denial of
 *   legacy-only methods mirrors it.
 * - Q10-L2: a hand-constructed server with the default `eraSupport` serves a
 *   scripted 2025 session with today's exact result shapes and zero 2026
 *   vocabulary on the wire.
 */
import type { JSONRPCErrorResponse, JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';

const MODERN = '2026-07-28';

/**
 * 2026-era vocabulary that must never leak into a legacy-direction response.
 * The gate answers with the same plain `-32601` a 2025 server answers for an
 * unknown method — nothing in message or data may reveal that the instance
 * also hosts the modern era.
 */
const FORBIDDEN_2026_VOCABULARY = [
    '2026',
    'discover',
    'envelope',
    'modern',
    'dual',
    'era',
    '_meta',
    'io.modelcontextprotocol',
    'resultType',
    'protocolVersion',
    'protocol version',
    'subscription'
];

/** The 2026-only request methods the era gate must hide from legacy-era traffic. */
const MODERN_ONLY_METHODS = ['server/discover', 'subscriptions/listen'];

/**
 * Legacy-only methods whose modern-direction denial mirrors the gate.
 * (`initialize` is deliberately not in this list: per the body-primary
 * predicate it is the legacy handshake by definition, so even an enveloped
 * `initialize` is served as legacy rather than denied.)
 */
const LEGACY_ONLY_METHODS = ['ping', 'logging/setLevel', 'resources/subscribe'];

const envelope = (overrides?: Record<string, unknown>) => ({
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'modern-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides
});

function buildServer(options?: { eraSupport?: 'legacy' | 'dual-era' | 'modern' }) {
    const server = new McpServer(
        { name: 'dual-era-test-server', version: '1.0.0' },
        {
            capabilities: { tools: {} },
            instructions: 'test instructions',
            ...(options?.eraSupport ? { eraSupport: options.eraSupport } : {})
        }
    );
    server.registerTool('echo', { description: 'Echoes the input text', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return server;
}

async function wire(server: McpServer) {
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
    return { request, notify, inbound, close: () => server.close() };
}

const initializeRequest = (id: number): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy-client', version: '1.0.0' } }
});

describe('dual-era serving on one long-lived connection', () => {
    it('serves the legacy vertical and the modern vertical on the same connection, each on its own era', async () => {
        const server = buildServer({ eraSupport: 'dual-era' });
        const { request, notify, close } = await wire(server);

        // --- Legacy vertical: initialize → initialized → tools/list → tools/call.
        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(JSON.stringify(init)).not.toContain('resultType');
            expect(JSON.stringify(init)).not.toContain('2026');
        }
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const legacyList = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(legacyList)).toBe(true);
        if (isJSONRPCResultResponse(legacyList)) {
            expect((legacyList.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toEqual(['echo']);
            expect(JSON.stringify(legacyList)).not.toContain('resultType');
        }

        const legacyCall = await request({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'legacy leg' } }
        });
        expect(isJSONRPCResultResponse(legacyCall)).toBe(true);
        if (isJSONRPCResultResponse(legacyCall)) {
            expect((legacyCall.result as { content: unknown[] }).content).toEqual([{ type: 'text', text: 'legacy leg' }]);
            expect(JSON.stringify(legacyCall)).not.toContain('resultType');
        }

        // --- Modern vertical on the SAME connection: discover → list → call,
        // every request carrying the per-request envelope.
        const discover = await request({ jsonrpc: '2.0', id: 4, method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(discover)).toBe(true);
        if (isJSONRPCResultResponse(discover)) {
            const result = discover.result as { supportedVersions?: string[]; resultType?: string };
            expect(result.supportedVersions).toEqual([MODERN]);
            expect(result.resultType).toBe('complete');
        }

        const modernList = await request({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(modernList)).toBe(true);
        if (isJSONRPCResultResponse(modernList)) {
            const result = modernList.result as { tools: Array<{ name: string }>; resultType?: string };
            expect(result.tools.map(tool => tool.name)).toEqual(['echo']);
            expect(result.resultType).toBe('complete');
        }

        const modernCall = await request({
            jsonrpc: '2.0',
            id: 6,
            method: 'tools/call',
            params: { name: 'echo', arguments: { text: 'modern leg' }, _meta: envelope() }
        });
        expect(isJSONRPCResultResponse(modernCall)).toBe(true);
        if (isJSONRPCResultResponse(modernCall)) {
            const result = modernCall.result as { content: unknown[]; resultType?: string };
            expect(result.content).toEqual([{ type: 'text', text: 'modern leg' }]);
            expect(result.resultType).toBe('complete');
        }

        // The legacy leg is unaffected by the modern exchanges that ran in between.
        const legacyAgain = await request({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(legacyAgain)).toBe(true);
        expect(JSON.stringify(legacyAgain)).not.toContain('resultType');

        await close();
    });

    it('the modern era is reachable without any prior legacy handshake (envelope-first connection)', async () => {
        const server = buildServer({ eraSupport: 'dual-era' });
        const { request, close } = await wire(server);

        const discover = await request({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope() } });
        expect(isJSONRPCResultResponse(discover)).toBe(true);
        await close();
    });
});

describe('long-lived era gate + zero-2026-vocabulary leak test', () => {
    it('a legacy-classified request for any 2026-only method answers a plain −32601 with zero 2026 vocabulary in message or data', async () => {
        const server = buildServer({ eraSupport: 'dual-era' });
        const { request, close } = await wire(server);

        // Establish the legacy leg first — the gate must hold on a connection
        // that is actively serving 2025 traffic.
        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);

        let id = 10;
        for (const method of MODERN_ONLY_METHODS) {
            // No envelope claim ⇒ classified legacy ⇒ the modern registry must be invisible.
            const response = await request({ jsonrpc: '2.0', id: (id += 1), method, params: {} });
            expect(isJSONRPCErrorResponse(response)).toBe(true);
            const error = (response as JSONRPCErrorResponse).error;
            expect(error.code).toBe(-32_601);
            expect(error.message).toBe('Method not found');
            expect(error.data).toBeUndefined();

            const serialized = JSON.stringify({ error, id: null });
            for (const term of FORBIDDEN_2026_VOCABULARY) {
                expect(serialized.toLowerCase()).not.toContain(term.toLowerCase());
            }
        }
        await close();
    });

    it('the modern-direction denial mirrors it: a modern-classified request for a legacy-only method answers −32601', async () => {
        const server = buildServer({ eraSupport: 'dual-era' });
        const { request, close } = await wire(server);

        let id = 20;
        for (const method of LEGACY_ONLY_METHODS) {
            const response = await request({ jsonrpc: '2.0', id: (id += 1), method, params: { _meta: envelope() } });
            expect(isJSONRPCErrorResponse(response)).toBe(true);
            const error = (response as JSONRPCErrorResponse).error;
            expect(error.code).toBe(-32_601);
            expect(error.message).toBe('Method not found');
        }
        await close();
    });
});

describe('Q10-L2: a hand-constructed server with the default eraSupport on 2025 traffic', () => {
    it('serves a scripted 2025 session with the exact 2025 shapes and zero 2026 vocabulary on the wire', async () => {
        const server = buildServer();
        const { request, notify, inbound, close } = await wire(server);

        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect(init.result).toEqual({
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: 'dual-era-test-server', version: '1.0.0' },
                instructions: 'test instructions'
            });
        }
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(isJSONRPCResultResponse(list)).toBe(true);
        if (isJSONRPCResultResponse(list)) {
            const tools = (list.result as { tools: Array<Record<string, unknown>> }).tools;
            expect(tools).toHaveLength(1);
            expect(tools[0]).toMatchObject({ name: 'echo', description: 'Echoes the input text' });
            expect(Object.keys(list.result as Record<string, unknown>).sort()).toEqual(['tools']);
        }

        const call = await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
        expect(isJSONRPCResultResponse(call)).toBe(true);
        if (isJSONRPCResultResponse(call)) {
            expect(call.result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
        }

        const ping = await request({ jsonrpc: '2.0', id: 4, method: 'ping' });
        expect(isJSONRPCResultResponse(ping)).toBe(true);
        if (isJSONRPCResultResponse(ping)) {
            expect(ping.result).toEqual({});
        }

        // A default instance keeps answering server/discover with -32601, byte-identical to the deployed fleet.
        const discover = await request({ jsonrpc: '2.0', id: 5, method: 'server/discover', params: {} });
        expect(isJSONRPCErrorResponse(discover)).toBe(true);
        if (isJSONRPCErrorResponse(discover)) {
            expect(discover.error).toEqual({ code: -32_601, message: 'Method not found' });
        }

        // Nothing the server wrote on this 2025 session carries 2026 wire vocabulary.
        const wireBytes = JSON.stringify(inbound);
        expect(wireBytes).not.toContain('resultType');
        expect(wireBytes).not.toContain('2026');
        expect(wireBytes).not.toContain('io.modelcontextprotocol/');

        await close();
    });
});
