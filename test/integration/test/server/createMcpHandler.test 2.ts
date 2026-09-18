/**
 * createMcpHandler served over real HTTP, driven by real clients: the
 * 2026-capable negotiation client for the modern path and a plain 2025 client
 * for the legacy fallback — both legacy postures (the stateless default and
 * the strict 'reject') on one endpoint, all backed by one factory.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    SUBSCRIPTION_ID_META_KEY
} from '@modelcontextprotocol/core-internal';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CreateMcpHandlerOptions, McpHttpHandler, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const MODERN = '2026-07-28';

describe('createMcpHandler over HTTP (legacy postures end to end)', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    // One factory for both legs: the era only shows up in the tool output so the
    // tests can see which leg served the call.
    const factory = (ctx: McpRequestContext) => {
        const mcpServer = new McpServer(
            { name: 'dual-era-endpoint', version: '1.0.0' },
            { capabilities: { tools: {} }, instructions: 'dual era endpoint' }
        );
        mcpServer.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
            content: [{ type: 'text', text: `hello ${name} (${ctx.era})` }]
        }));
        return mcpServer;
    };

    async function startEndpoint(options?: CreateMcpHandlerOptions): Promise<{ baseUrl: URL; handler: McpHttpHandler }> {
        const handler = createMcpHandler(factory, options);
        const httpServer: HttpServer = createServer(toNodeHandler(handler));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await handler.close();
            httpServer.close();
        });
        return { baseUrl, handler };
    }

    it('serves the modern era to an auto-negotiating client (default endpoint)', async () => {
        const { baseUrl } = await startEndpoint();

        const client = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getServerVersion()).toEqual({ name: 'dual-era-endpoint', version: '1.0.0' });
        expect(client.getInstructions()).toBe('dual era endpoint');

        const result = await client.callTool({ name: 'greet', arguments: { name: 'modern' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hello modern (modern)' }]);
    });

    it("rejects a plain 2025 client on a strict (legacy: 'reject') endpoint with the unsupported-protocol-version error", async () => {
        const { baseUrl } = await startEndpoint({ legacy: 'reject' });

        const client = new Client({ name: 'legacy-client', version: '1.0.0' });
        await expect(client.connect(new StreamableHTTPClientTransport(baseUrl))).rejects.toThrow(/Unsupported protocol version|400/);
        cleanups.push(() => client.close().catch(() => {}));
    });

    it('serves a plain 2025 client through the default stateless legacy fallback while the modern path keeps working', async () => {
        const { baseUrl } = await startEndpoint();

        const legacyClient = new Client({ name: 'legacy-client', version: '1.0.0' });
        await legacyClient.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => legacyClient.close());

        expect(legacyClient.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        const legacyResult = await legacyClient.callTool({ name: 'greet', arguments: { name: 'old friend' } });
        expect(legacyResult.content).toEqual([{ type: 'text', text: 'hello old friend (legacy)' }]);

        const modernClient = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await modernClient.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => modernClient.close());

        expect(modernClient.getNegotiatedProtocolVersion()).toBe(MODERN);
        const modernResult = await modernClient.callTool({ name: 'greet', arguments: { name: 'new friend' } });
        expect(modernResult.content).toEqual([{ type: 'text', text: 'hello new friend (modern)' }]);
    });

    it('pinning the modern revision works against the entry and never sends initialize', async () => {
        const { baseUrl } = await startEndpoint({ legacy: 'stateless' });

        const bodies: string[] = [];
        const recordingFetch: typeof fetch = async (input, init) => {
            if (typeof init?.body === 'string') bodies.push(init.body);
            return fetch(input, init);
        };

        const client = new Client({ name: 'pin-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: recordingFetch }));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(bodies.some(body => body.includes('"initialize"'))).toBe(false);
        expect(bodies[0]).toContain('server/discover');
    });

    it('answers an envelope claiming an unsupported revision with the supported list over plain HTTP', async () => {
        const { baseUrl } = await startEndpoint();

        // A request whose envelope claims an unsupported revision is answered with
        // the unsupported-protocol-version error over plain HTTP 400.
        const response = await fetch(new URL('/mcp', baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'x' },
                    _meta: {
                        [PROTOCOL_VERSION_META_KEY]: '2030-01-01',
                        [CLIENT_INFO_META_KEY]: { name: 'integration-client', version: '1.0.0' },
                        [CLIENT_CAPABILITIES_META_KEY]: {}
                    }
                }
            })
        });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { id: unknown; error: { code: number; data: { supported: string[] } } };
        expect(body.error.code).toBe(-32_022);
        expect(body.error.data.supported).toEqual([MODERN]);
        // The rejection echoes the request id it answers (it could be read from the body).
        expect(body.id).toBe(1);
    });
});

describe('createMcpHandler over HTTP — subscriptions/listen honored filter', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    it("drops a requested type the server's declared capabilities do not advertise", async () => {
        // Factory declares tools.listChanged but NOT prompts.listChanged: a listen
        // request that asks for both must be acknowledged with prompts dropped —
        // the honored filter is narrowed against the per-serve instance's
        // capabilities, not echoed verbatim.
        const handler = createMcpHandler(
            () => new McpServer({ name: 'caps-gated', version: '1' }, { capabilities: { tools: { listChanged: true } } }),
            { keepAliveMs: 0 }
        );
        const httpServer: HttpServer = createServer(toNodeHandler(handler));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await handler.close();
            httpServer.close();
        });

        const response = await fetch(new URL('/mcp', baseUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'mcp-method': 'subscriptions/listen'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sub-1',
                method: 'subscriptions/listen',
                params: {
                    _meta: {
                        [PROTOCOL_VERSION_META_KEY]: MODERN,
                        [CLIENT_INFO_META_KEY]: { name: 'integration-client', version: '1.0.0' },
                        [CLIENT_CAPABILITIES_META_KEY]: {}
                    },
                    notifications: { toolsListChanged: true, promptsListChanged: true }
                }
            })
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/event-stream');

        // Read the first SSE frame (the ack) and stop.
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let ack: { method: string; params: { notifications: Record<string, unknown>; _meta: Record<string, unknown> } } | undefined;
        while (ack === undefined) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const idx = buffer.indexOf('\n\n');
            if (idx !== -1) {
                const frame = buffer.slice(0, idx);
                const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
                if (dataLine) ack = JSON.parse(dataLine.slice(6));
            }
        }
        await reader.cancel();

        expect(ack?.method).toBe('notifications/subscriptions/acknowledged');
        expect(ack?.params.notifications).toEqual({ toolsListChanged: true });
        expect(ack?.params.notifications).not.toHaveProperty('promptsListChanged');
        expect(ack?.params._meta[SUBSCRIPTION_ID_META_KEY]).toBe('sub-1');
    });
});
