import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike } from '@modelcontextprotocol/core';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { LegacyTestClient } from './fixtures/testClient.js';

function fetchVia(handler: (req: Request) => Promise<Response>): FetchLike {
    return async (input, init) => handler(new Request(input, init));
}

// Same shape as scratch/httpServer.ts: makeMcpServer + one transport instance.
function makeMcpServer() {
    const mcp = new McpServer({ name: 'scratch-http', version: '0.0.1' });
    mcp.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    mcp.registerTool('greet', { inputSchema: z.object({}) }, async (_args, ctx) => {
        const r = await ctx.mcpReq.elicitInput({
            message: 'What is your name?',
            requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
        });
        if (r.action !== 'accept' || !r.content?.name) return { content: [{ type: 'text', text: 'No name provided.' }] };
        return { content: [{ type: 'text', text: `hello, ${r.content.name as string}` }] };
    });
    return mcp;
}

const URL_ = new URL('http://test.local/mcp');

function newRoutedTransport() {
    return new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        createMcpServer: makeMcpServer
    });
}

function newClient(ctor: typeof Client, transport: WebStandardStreamableHTTPServerTransport) {
    const client = new ctor({ name: 'cli', version: '0.0.1' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'Felix' } }));
    const t = new StreamableHTTPClientTransport(URL_, { fetch: fetchVia(req => transport.handleRequest(req)) });
    return { client, clientTransport: t };
}

describe('WebStandardStreamableHTTPServerTransport createMcpServer (router mode)', () => {
    it('serves a stateless 2026-06 client (per-request server)', async () => {
        const transport = newRoutedTransport();
        const { client, clientTransport } = newClient(Client, transport);
        await client.connect(clientTransport);
        expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

        const echo = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        expect(echo.content).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('serves a legacy client with SDK-owned session map', async () => {
        const transport = newRoutedTransport();
        const { client, clientTransport } = newClient(LegacyTestClient, transport);
        await client.connect(clientTransport);
        // legacy client must have negotiated a stateful version and got a session id
        expect(LATEST_PROTOCOL_VERSION).not.toBe(client.getNegotiatedProtocolVersion());
        expect(clientTransport.sessionId).toBeDefined();

        const echo = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        expect(echo.content).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('serves both client kinds against ONE transport instance, including greet (MRTR over HTTP)', async () => {
        const transport = newRoutedTransport();

        const legacy = newClient(LegacyTestClient, transport);
        await legacy.client.connect(legacy.clientTransport);
        const greetLegacy = await legacy.client.callTool({ name: 'greet', arguments: {} });
        expect(greetLegacy.content).toEqual([{ type: 'text', text: 'hello, Felix' }]);

        const stateless = newClient(Client, transport);
        await stateless.client.connect(stateless.clientTransport);
        const greetStateless = await stateless.client.callTool({ name: 'greet', arguments: {} });
        expect(greetStateless.content).toEqual([{ type: 'text', text: 'hello, Felix' }]);
    });

    it('without createMcpServer, behavior is unchanged (single-session transport)', async () => {
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
        await makeMcpServer().connect(transport);
        const { client, clientTransport } = newClient(LegacyTestClient, transport);
        await client.connect(clientTransport);
        const echo = await client.callTool({ name: 'echo', arguments: { text: 'x' } });
        expect(echo.content).toEqual([{ type: 'text', text: 'x' }]);
    });
});
