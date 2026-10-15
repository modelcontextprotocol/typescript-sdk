import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const output = { id: 'n1', body: 'hello' };
const inline = z.object({ id: z.string(), body: z.string() });
const referenced = fromJsonSchema<typeof output>({
    $ref: '#/$defs/Note',
    $defs: {
        Note: {
            type: 'object',
            properties: { id: { type: 'string' }, body: { type: 'string' } },
            required: ['id', 'body']
        }
    }
});

describe('named object output schemas', () => {
    test.each(['2025-11-25', '2026-07-28'] as const)('preserves object results on %s', async version => {
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: 'named-output-server', version: '1.0.0' });
            for (const [name, outputSchema] of Object.entries({ inline, referenced })) {
                server.registerTool(name, { outputSchema }, async () => ({ content: [], structuredContent: output }));
            }
            for (const [name, schema] of Object.entries({ string: { type: 'string' }, typeless: { additionalProperties: false } })) {
                server.registerTool(
                    name,
                    { outputSchema: fromJsonSchema<string>({ $ref: '#/$defs/Text', $defs: { Text: schema } }) },
                    async () => ({ content: [], structuredContent: 'hello' })
                );
            }
            server.registerTool('invalid', { outputSchema: referenced }, async () => ({
                content: [],
                structuredContent: { id: 'n1' } as typeof output
            }));
            return server;
        });
        const client = new Client(
            { name: 'named-output-client', version: '1.0.0' },
            { versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' } }
        );
        try {
            await client.connect(
                new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                    fetch: (url, init) => handler.fetch(new Request(url, init))
                })
            );
            expect(client.getNegotiatedProtocolVersion()).toBe(version);
            const { tools } = await client.listTools();
            for (const name of ['inline', 'referenced']) {
                const result = await client.callTool({ name, arguments: {} });
                expect(result.structuredContent).toEqual(output);
                if (version !== '2026-07-28') {
                    const schema = tools.find(tool => tool.name === name)?.outputSchema;
                    expect(schema).toMatchObject({ type: 'object' });
                    expect(schema).not.toHaveProperty('properties.result');
                }
            }
            for (const name of ['string', 'typeless']) {
                const stringResult = await client.callTool({ name });
                expect(stringResult.structuredContent).toEqual(version === '2026-07-28' ? 'hello' : { result: 'hello' });
            }
            const invalidResult = await client.callTool({ name: 'invalid' });
            expect(invalidResult.isError).toBe(true);
        } finally {
            await client.close();
        }
    });
});
