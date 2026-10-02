import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '../../src/index';

async function callArrayTool(items: unknown, options?: { maxToolInputElements?: number }): Promise<JSONRPCMessage> {
    const server = new McpServer({ name: 'test', version: '1.0.0' }, options);
    server.registerTool('t', { inputSchema: { items: z.array(z.string()) } }, () => ({
        content: [{ type: 'text' as const, text: 'ok' }]
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const received: JSONRPCMessage[] = [];
    clientTransport.onmessage = message => void received.push(message);
    await server.connect(serverTransport);
    await clientTransport.start();

    await clientTransport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1.0.0' } }
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't', arguments: { items } } });
    await new Promise(resolve => setTimeout(resolve, 10));
    await server.close();

    const response = received.find(message => (message as { id?: unknown }).id === 2);
    if (!response) {
        throw new Error('no tools/call response received');
    }
    return response;
}

function resultOf(message: JSONRPCMessage): { content?: Array<{ text?: string }>; isError?: boolean } | undefined {
    return (message as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }).result;
}

describe('maxToolInputElements', () => {
    it('accepts a large array when no limit is set', async () => {
        const result = resultOf(await callArrayTool(Array(60_000).fill('x')));
        expect(result?.isError).toBeFalsy();
        expect(result?.content?.[0]?.text).toBe('ok');
    });

    it('refuses arguments past a configured limit', async () => {
        const result = resultOf(await callArrayTool(Array(60_000).fill('x'), { maxToolInputElements: 1_000 }));
        expect(result?.isError).toBe(true);
        expect(result?.content?.[0]?.text).toContain('more than the maximum');
    });

    it('accepts arguments within a configured limit', async () => {
        const result = resultOf(await callArrayTool(Array(1_000).fill('x'), { maxToolInputElements: 2_000 }));
        expect(result?.isError).toBeFalsy();
        expect(result?.content?.[0]?.text).toBe('ok');
    });

    it('treats Infinity as no limit', async () => {
        const result = resultOf(await callArrayTool(Array(60_000).fill('x'), { maxToolInputElements: Infinity }));
        expect(result?.isError).toBeFalsy();
        expect(result?.content?.[0]?.text).toBe('ok');
    });

    it('rejects a non-finite or non-positive limit at construction', () => {
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: Number.NaN })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: 0 })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0.0' }, { maxToolInputElements: -1 })).toThrow();
    });
});
