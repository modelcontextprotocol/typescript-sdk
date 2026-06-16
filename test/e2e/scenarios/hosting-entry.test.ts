/**
 * Self-contained test bodies for the dual-era HTTP entry (`createMcpHandler`).
 *
 * Unlike most scenario areas these do not use `wire()`: every body hosts the
 * handler's `node` face on a real `node:http` listener (the same wiring as
 * `test/integration/test/server/createMcpHandler.test.ts`) and drives it with
 * real SDK clients or plain fetch. The requirements therefore restrict the
 * matrix transport axis to a single HTTP transport, and the spec-version axis
 * selects which era a cell drives where the requirement spans both.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import type {
    CallToolResult,
    CreateMcpHandlerOptions,
    McpHttpHandler,
    McpRequestContext,
    McpServerFactory
} from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';

/** The per-request `_meta` envelope every 2026-era request carries (attached explicitly until automatic emission lands client-side). */
function modernEnvelope(name = 'e2e-entry-client') {
    return {
        [PROTOCOL_VERSION_META_KEY]: MODERN,
        [CLIENT_INFO_META_KEY]: { name, version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: {}
    };
}

/** One ctx-taking factory backing every cell: the era only shows up in the tool output so tests can see which leg served the call. */
function greetFactory(ctx: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'e2e-entry', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name} (${ctx.era})` }]
    }));
    return server;
}

interface Endpoint extends AsyncDisposable {
    baseUrl: URL;
    handler: McpHttpHandler;
}

/** Hosts the handler's node face on a real node:http listener bound to an ephemeral port. */
async function startEndpoint(factory: McpServerFactory, options?: CreateMcpHandlerOptions): Promise<Endpoint> {
    const handler = createMcpHandler(factory, options);
    const httpServer: HttpServer = createServer((req, res) => void handler.node(req, res));
    const baseUrl = await listenOnRandomPort(httpServer);
    return {
        baseUrl,
        handler,
        [Symbol.asyncDispose]: async () => {
            await handler.close();
            await new Promise<void>((resolve, reject) => httpServer.close(error => (error ? reject(error) : resolve())));
        }
    };
}

verifies('typescript:hosting:entry:dual-era-one-factory', async ({ protocolVersion }: TestArgs) => {
    await using endpoint = await startEndpoint(greetFactory, { legacy: 'stateless' });

    if (protocolVersion === LEGACY) {
        // 2025-era leg: a plain client is served per request through the
        // legacy 'stateless' slot — initialize → tools/list → tools/call.
        const client = new Client({ name: 'plain-2025-client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(endpoint.baseUrl));
        try {
            expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);
            const tools = await client.listTools();
            expect(tools.tools.map(tool => tool.name)).toEqual(['greet']);
            const result = await client.callTool({ name: 'greet', arguments: { name: 'old friend' } });
            expect(result.content).toEqual([{ type: 'text', text: 'hello old friend (legacy)' }]);
        } finally {
            await client.close();
        }
        return;
    }

    // 2026-era leg: the auto-negotiating client reaches 2026-07-28 via
    // server/discover — never initialize — and tools/call is served with the
    // per-request envelope.
    const requestBodies: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
        if (typeof init?.body === 'string') requestBodies.push(init.body);
        return fetch(input, init);
    };
    const client = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(endpoint.baseUrl, { fetch: recordingFetch }));
    try {
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        // The "(never initialize)" clause of the requirement, asserted on the
        // recorded wire traffic: no request body ever carried an initialize,
        // and the negotiation rode server/discover.
        expect(requestBodies.some(body => body.includes('"initialize"'))).toBe(false);
        expect(requestBodies.some(body => body.includes('server/discover'))).toBe(true);
        const result = (await client.request({
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 'new friend' }, _meta: modernEnvelope('auto-client') }
        })) as CallToolResult;
        expect(result.content).toEqual([{ type: 'text', text: 'hello new friend (modern)' }]);
        // ...and still no initialize anywhere on the wire after the tool call —
        // the whole conversation rode the modern handshake.
        expect(requestBodies.some(body => body.includes('"initialize"'))).toBe(false);
    } finally {
        await client.close();
    }
});

verifies('typescript:hosting:entry:pin-negotiation', async (_args: TestArgs) => {
    // Strict endpoint (no legacy slot): the pinned client never needs one.
    await using endpoint = await startEndpoint(greetFactory);

    const bodies: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return fetch(input, init);
    };

    const client = new Client({ name: 'pin-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(new StreamableHTTPClientTransport(endpoint.baseUrl, { fetch: recordingFetch }));
    try {
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        // No initialize was ever put on the wire; the first request is the discover probe.
        expect(bodies.some(body => body.includes('"initialize"'))).toBe(false);
        expect(bodies[0]).toContain('server/discover');

        const result = (await client.request({
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 'pinned' }, _meta: modernEnvelope('pin-client') }
        })) as CallToolResult;
        expect(result.content).toEqual([{ type: 'text', text: 'hello pinned (modern)' }]);
        // ...and still no initialize anywhere on the wire after the tool call.
        expect(bodies.some(body => body.includes('"initialize"'))).toBe(false);
    } finally {
        await client.close();
    }
});

verifies('typescript:hosting:entry:strict-rejects-legacy', async (_args: TestArgs) => {
    // legacy omitted → modern-only strict: no silent 2025 serving.
    await using endpoint = await startEndpoint(greetFactory);

    // The documented strict cell over plain HTTP: a 2025-shaped initialize is
    // answered with the unsupported-protocol-version error naming the
    // supported modern revisions (the numeric code is not pinned here).
    const response = await fetch(endpoint.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'plain-2025-client', version: '1.0.0' } }
        })
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string; data?: { supported?: string[] } } };
    expect(body.error.message).toMatch(/unsupported protocol version/i);
    expect(body.error.data?.supported).toContain(MODERN);

    // The plain SDK client sees the same rejection at connect time.
    const client = new Client({ name: 'plain-2025-client', version: '1.0.0' });
    try {
        await expect(client.connect(new StreamableHTTPClientTransport(endpoint.baseUrl))).rejects.toThrow(
            /Unsupported protocol version|400/
        );
    } finally {
        await client.close().catch(() => {});
    }
});

verifies('typescript:hosting:entry:notification-202', async ({ protocolVersion }: TestArgs) => {
    await using endpoint = await startEndpoint(greetFactory, { legacy: 'stateless' });

    // 2025 leg: an envelope-less notification rides the legacy stateless slot.
    // 2026 leg: the notification carries the per-request envelope and a method
    // the 2026-07-28 registry defines.
    const notification =
        protocolVersion === LEGACY
            ? { jsonrpc: '2.0', method: 'notifications/initialized' }
            : {
                  jsonrpc: '2.0',
                  method: 'notifications/cancelled',
                  params: { requestId: 'never-issued', reason: 'probe', _meta: modernEnvelope() }
              };

    const response = await fetch(endpoint.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(notification)
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
});
