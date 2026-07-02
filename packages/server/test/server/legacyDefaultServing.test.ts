/**
 * Q10-L2 golden pin: a hand-constructed `McpServer` connected to a long-lived
 * transport (the shape of every existing stdio server) serves a scripted 2025
 * session with today's exact result shapes and zero 2026 vocabulary on the
 * wire — and keeps answering `server/discover` with `-32601`, byte-identical
 * to the deployed fleet. Hand-constructed instances serve only the 2025 era;
 * serving the 2026-07-28 revision on stdio goes through the `serveStdio`
 * entry (covered in `serveStdio.test.ts`).
 */
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import {
    InMemoryTransport,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    LATEST_LEGACY_PROTOCOL_VERSION
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';

function buildServer() {
    const server = new McpServer(
        { name: 'legacy-default-test-server', version: '1.0.0' },
        { capabilities: { tools: {} }, instructions: 'test instructions' }
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
    params: { protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy-client', version: '1.0.0' } }
});

describe('Q10-L2: a hand-constructed server on 2025 traffic', () => {
    it('serves a scripted 2025 session with the exact 2025 shapes and zero 2026 vocabulary on the wire', async () => {
        const server = buildServer();
        const { request, notify, inbound, close } = await wire(server);

        const init = await request(initializeRequest(1));
        expect(isJSONRPCResultResponse(init)).toBe(true);
        if (isJSONRPCResultResponse(init)) {
            expect(init.result).toEqual({
                protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: 'legacy-default-test-server', version: '1.0.0' },
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
