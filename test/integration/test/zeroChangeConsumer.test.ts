import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { LegacyTestClient } from './fixtures/testClient.js';

// Mirrors scratch/stdioServer.ts: a server whose author wrote nothing
// version-aware. greet awaits ctx.mcpReq.elicitInput like any 2025-11 server.
function makeMcpServer() {
    const mcp = new McpServer({ name: 'scratch', version: '0.0.1' });
    mcp.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    mcp.registerTool('greet', { inputSchema: z.object({}) }, async (_args, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            message: 'What is your name?',
            requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
        });
        if (result.action !== 'accept' || !result.content?.name) {
            return { content: [{ type: 'text', text: 'No name provided.' }] };
        }
        return { content: [{ type: 'text', text: `hello, ${result.content.name as string}` }] };
    });
    return mcp;
}

// Mirrors scratch/cliClient.ts: registers an elicitation handler exactly as
// today's docs describe, with no awareness of MRTR or resultType.
function makeClient(ctor: typeof Client) {
    const client = new ctor({ name: 'cli', version: '0.0.1' }, { capabilities: { elicitation: { form: {} } } });
    const handler = vi.fn(async () => ({ action: 'accept' as const, content: { name: 'Felix' } }));
    client.setRequestHandler('elicitation/create', handler);
    return { client, handler };
}

describe.each([
    ['stateless (Client auto-discovers)', Client],
    ['legacy (LegacyTestClient)', LegacyTestClient]
] as const)('zero-change consumer over InMemory: %s', (_label, ctor) => {
    async function setup() {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const mcp = makeMcpServer();
        const { client, handler } = makeClient(ctor);
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        return { client, handler };
    }

    it('echo works', async () => {
        const { client } = await setup();
        const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('greet: ctx.mcpReq.elicitInput resolves via the registered handler', async () => {
        const { client, handler } = await setup();
        const result = await client.callTool({ name: 'greet', arguments: {} });
        expect(handler).toHaveBeenCalledOnce();
        expect(result.content).toEqual([{ type: 'text', text: 'hello, Felix' }]);
    });
});
