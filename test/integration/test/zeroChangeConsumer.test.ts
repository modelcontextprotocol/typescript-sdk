import { Client } from '@modelcontextprotocol/client';
import type { CreateMessageResult } from '@modelcontextprotocol/core';
import { InMemoryTransport, InputRequiredError, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { LegacyTestClient } from './__fixtures__/testClient.js';

// Mirrors a server whose author wrote nothing version-aware. greet awaits
// ctx.mcpReq.elicitInput like any 2025-11 server.
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

describe('MRTR hardening (stateless only)', () => {
    async function connect(mcp: McpServer, caps: Record<string, unknown>) {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'cli', version: '0.0.1' }, { capabilities: caps });
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        return client;
    }

    it('two sequential elicitInput calls converge (accumulate fix)', async () => {
        const mcp = new McpServer({ name: 's', version: '1' });
        mcp.registerTool('two', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const a = await ctx.mcpReq.elicitInput({
                message: 'a',
                requestedSchema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }
            });
            const b = await ctx.mcpReq.elicitInput({
                message: 'b',
                requestedSchema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }
            });
            const av = a.action === 'accept' ? a.content?.v : '?';
            const bv = b.action === 'accept' ? b.content?.v : '?';
            return { content: [{ type: 'text', text: `${av as string},${bv as string}` }] };
        });
        const client = await connect(mcp, { elicitation: { form: {} } });
        let n = 0;
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept' as const, content: { v: `r${n++}` } }));
        const result = await client.callTool({ name: 'two', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'r0,r1' }]);
    });

    it('client auto-resume throws after max rounds when server never converges', async () => {
        const mcp = new McpServer({ name: 's', version: '1' });
        let round = 0;
        mcp.registerTool('loop', { inputSchema: z.object({}) }, async () => {
            throw new InputRequiredError({
                [`k-${round++}`]: {
                    method: 'elicitation/create',
                    params: { message: 'x', requestedSchema: { type: 'object', properties: {}, required: [] } }
                }
            });
        });
        const client = await connect(mcp, { elicitation: { form: {} } });
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));
        await expect(client.callTool({ name: 'loop', arguments: {} })).rejects.toSatisfy(
            (e: unknown) => e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout && /MRTR exceeded \d+ rounds/.test(e.message)
        );
    });

    it('requestSampling resolves via sampling/createMessage handler (throw-then-cache)', async () => {
        const mcp = new McpServer({ name: 's', version: '1' });
        mcp.registerTool('ask', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const r = await ctx.mcpReq.requestSampling({
                messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
                maxTokens: 10
            });
            return { content: [{ type: 'text', text: (r.content as { text: string }).text }] };
        });
        const client = await connect(mcp, { sampling: {} });
        const handler = vi.fn(
            async (): Promise<CreateMessageResult> => ({
                role: 'assistant',
                content: { type: 'text', text: 'sampled!' },
                model: 'stub'
            })
        );
        client.setRequestHandler('sampling/createMessage', handler);
        const result = await client.callTool({ name: 'ask', arguments: {} });
        expect(handler).toHaveBeenCalledOnce();
        expect(result.content).toEqual([{ type: 'text', text: 'sampled!' }]);
    });
});
