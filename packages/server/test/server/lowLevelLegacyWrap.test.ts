/**
 * SEP-2106 legacy projection lives in the wire codec — proven on a low-level
 * `Server` (NOT `McpServer`). The handler is era-blind and returns a
 * non-object `outputSchema` / `structuredContent` directly; on a 2025-era
 * connection the WIRE BYTES carry the wrapped `{type:'object',
 * properties:{result:…}}` schema and the wrapped `{result:<value>}`
 * structured content. Nothing in `mcp.ts` (or any server-side code) re-derives
 * the wrap — the only era branch is the codec.
 */
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, isJSONRPCResultResponse, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Server } from '../../src/server/server';

async function wire(server: Server) {
    const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();
    const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
    peerTx.onmessage = message => {
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
    return { request, notify };
}

const initializeRequest = (id: number): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'legacy-client', version: '1.0.0' } }
});

describe('SEP-2106: the 2025 wire codec owns the legacy {result:…} wrap (low-level Server)', () => {
    it("encodeResult('tools/list') wraps a non-object outputSchema root on the wire", async () => {
        const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: {} } });
        // Era-blind handler: returns the natural (2026-vocabulary) array-rooted outputSchema.
        server.setRequestHandler('tools/list', () => ({
            tools: [{ name: 'x', inputSchema: { type: 'object' as const }, outputSchema: { type: 'array', items: { type: 'number' } } }]
        }));
        const { request, notify } = await wire(server);
        await request(initializeRequest(1));
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const reply = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        if (!isJSONRPCResultResponse(reply)) throw new Error(`expected result, got ${JSON.stringify(reply)}`);
        const tools = (reply.result as { tools: ReadonlyArray<{ name: string; outputSchema?: unknown }> }).tools;
        // Wire bytes carry the 2025-era projection — wrapped, not the natural schema.
        expect(tools[0]?.outputSchema).toEqual({
            type: 'object',
            properties: { result: { type: 'array', items: { type: 'number' } } },
            required: ['result']
        });
    });

    it('projectCallToolResult wraps structuredContent as {result:…} when the advertised schema has a non-object root', async () => {
        const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: {} } });
        const advertised = { type: 'array', items: { type: 'number' } } as const;
        server.setRequestHandler('tools/list', () => ({
            tools: [{ name: 'x', inputSchema: { type: 'object' as const }, outputSchema: advertised }]
        }));
        // Low-level handlers route the result-side projection through the codec themselves
        // (McpServer's tools/call handler does the same call). The codec is the ONLY place
        // the era branch lives.
        server.setRequestHandler('tools/call', () =>
            server.projectCallToolResult({ content: [], structuredContent: [1, 2, 3] }, advertised)
        );
        const { request, notify } = await wire(server);
        await request(initializeRequest(1));
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const reply = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } });
        if (!isJSONRPCResultResponse(reply)) throw new Error(`expected result, got ${JSON.stringify(reply)}`);
        const result = reply.result as { structuredContent?: unknown; content?: ReadonlyArray<{ type: string; text?: string }> };
        expect(result.structuredContent).toEqual({ result: [1, 2, 3] });
        // The era-agnostic SEP-2106 §4.3 TextContent auto-append also lives behind the codec.
        expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify([1, 2, 3]) });
    });

    it('projectCallToolResult wraps a non-object structuredContent value as {result:…} REGARDLESS of advertised schema (schema-less tool)', async () => {
        // A schema-less tool (no `outputSchema` advertised) returning a non-object
        // `structuredContent` would otherwise ship wire-illegal bytes on the 2025
        // era — the wire shape requires `structuredContent` to be an object. The
        // projection wraps on value shape alone, so the result is always
        // wire-legal even when there is no schema to consult.
        const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: {} } });
        server.setRequestHandler('tools/list', () => ({
            tools: [{ name: 'x', inputSchema: { type: 'object' as const } }]
        }));
        server.setRequestHandler('tools/call', () =>
            server.projectCallToolResult({ content: [], structuredContent: [1, 2, 3] }, undefined)
        );
        const { request, notify } = await wire(server);
        await request(initializeRequest(1));
        await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

        const reply = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } });
        if (!isJSONRPCResultResponse(reply)) throw new Error(`expected result, got ${JSON.stringify(reply)}`);
        const result = reply.result as { structuredContent?: unknown; content?: ReadonlyArray<{ type: string; text?: string }> };
        expect(result.structuredContent).toEqual({ result: [1, 2, 3] });
        expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify([1, 2, 3]) });
    });
});
