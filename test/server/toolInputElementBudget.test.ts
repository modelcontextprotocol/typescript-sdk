import { Client } from '../../src/client/index.js';
import { InMemoryTransport } from '../../src/inMemory.js';
import { McpServer } from '../../src/server/mcp.js';
import { z } from 'zod';

async function callArrayTool(
    items: unknown,
    options?: { maxToolInputElements?: number }
): Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> {
    const mcpServer = new McpServer({ name: 'test', version: '1.0' }, options);
    mcpServer.registerTool('t', { inputSchema: { items: z.array(z.string()) } }, () => ({
        content: [{ type: 'text' as const, text: 'ok' }]
    }));

    const client = new Client({ name: 'c', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), mcpServer.server.connect(serverTransport)]);

    return (await client.callTool({ name: 't', arguments: { items } })) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
    };
}

describe('maxToolInputElements', () => {
    it('accepts a large array when no limit is set', async () => {
        const result = await callArrayTool(Array(60_000).fill('x'));
        expect(result.isError).toBeFalsy();
        expect(result.content?.[0]?.text).toBe('ok');
    });

    it('refuses arguments past a configured limit', async () => {
        const result = await callArrayTool(Array(60_000).fill('x'), { maxToolInputElements: 1_000 });
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toContain('more than the maximum');
    });

    it('accepts arguments within a configured limit', async () => {
        const result = await callArrayTool(Array(1_000).fill('x'), { maxToolInputElements: 2_000 });
        expect(result.isError).toBeFalsy();
        expect(result.content?.[0]?.text).toBe('ok');
    });

    it('treats Infinity as no limit', async () => {
        const result = await callArrayTool(Array(60_000).fill('x'), { maxToolInputElements: Infinity });
        expect(result.isError).toBeFalsy();
        expect(result.content?.[0]?.text).toBe('ok');
    });

    it('rejects a non-finite or non-positive limit at construction', () => {
        expect(() => new McpServer({ name: 't', version: '1.0' }, { maxToolInputElements: Number.NaN })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0' }, { maxToolInputElements: 0 })).toThrow();
        expect(() => new McpServer({ name: 't', version: '1.0' }, { maxToolInputElements: -1 })).toThrow();
    });
});
