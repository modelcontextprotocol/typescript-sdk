/**
 * Discover round-trip: a pin-mode 2026 client completes `server/discover` →
 * version selection against a modern server over real HTTP, plus the
 * era-aware counter-offer end to end (a legacy client against a server whose
 * supported list carries a 2026 revision never sees a 2026 version string).
 *
 * Serving a 2026-era revision on a hand-constructed instance is a declared
 * act: the servers under test pass `eraSupport: 'dual-era'` (a modern
 * revision in the supported list without that declaration is a
 * construction-time TypeError), and a dual-era instance answers the
 * `server/discover` probe per message with no instance binding.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SdkError, SdkErrorCode, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const MODERN = '2026-07-28';
const DUAL_ERA_VERSIONS = [MODERN, ...SUPPORTED_PROTOCOL_VERSIONS];

function recordingFetch() {
    const bodies: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
        if (typeof init?.body === 'string') bodies.push(init.body);
        return fetch(input, init);
    };
    return { bodies, fetchFn };
}

describe('server/discover round-trip against a modern server', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    async function startServer(options: { kind: 'dual-era' | 'legacy-only' }) {
        const httpServer: HttpServer = createServer();
        const mcpServer = new McpServer(
            { name: 'dual-era-server', version: '2.0.0' },
            {
                capabilities: { tools: { listChanged: true } },
                instructions: 'dual era',
                ...(options.kind === 'dual-era' ? { supportedProtocolVersions: DUAL_ERA_VERSIONS, eraSupport: 'dual-era' as const } : {})
            }
        );
        mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcpServer.connect(serverTransport);
        httpServer.on('request', (req, res) => void serverTransport.handleRequest(req, res));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await mcpServer.close().catch(() => {});
            await serverTransport.close().catch(() => {});
            httpServer.close();
        });
        return baseUrl;
    }

    it('pin-mode 2026 client: server/discover → version selection, no initialize ever sent', async () => {
        const baseUrl = await startServer({ kind: 'dual-era' });
        const { bodies, fetchFn } = recordingFetch();

        const client = new Client({ name: 'pin-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: fetchFn }));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getServerVersion()).toEqual({ name: 'dual-era-server', version: '2.0.0' });
        expect(client.getInstructions()).toBe('dual era');
        // The advertisement excludes listChanged-class capabilities, visible end to end.
        expect(client.getServerCapabilities()).toEqual({ tools: {} });

        expect(bodies.some(b => b.includes('"initialize"'))).toBe(false);
        expect(bodies[0]).toContain('server/discover');
    });

    it('auto-mode client selects the modern era on the same server', async () => {
        const baseUrl = await startServer({ kind: 'dual-era' });
        const client = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    });

    it('auto-mode against a server that has not opted into modern-era support falls back to the legacy handshake', async () => {
        // A hand-constructed server with the default eraSupport never serves
        // server/discover: the probe is answered -32601 and the client falls
        // back cleanly on the same connection.
        const baseUrl = await startServer({ kind: 'legacy-only' });
        const client = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        const result = await client.callTool({ name: 'echo', arguments: { text: 'fallback' } });
        expect(result.content).toEqual([{ type: 'text', text: 'fallback' }]);
    });

    it('a plain legacy client against a dual-era server never meets a 2026 version string (counter-offer ordering, e2e)', async () => {
        const baseUrl = await startServer({ kind: 'dual-era' });
        const { fetchFn } = recordingFetch();

        const responses: string[] = [];
        const sniffingFetch: typeof fetch = async (input, init) => {
            const response = await fetchFn(input, init);
            responses.push(
                await response
                    .clone()
                    .text()
                    .catch(() => '')
            );
            return response;
        };

        const client = new Client({ name: 'legacy-client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: sniffingFetch }));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        const result = await client.callTool({ name: 'echo', arguments: { text: 'legacy' } });
        expect(result.content).toEqual([{ type: 'text', text: 'legacy' }]);

        // The 2026 revision never appears in any response the legacy client received.
        for (const body of responses) {
            expect(body).not.toContain(MODERN);
        }
    });

    it('client.discover() on a legacy-era connection is rejected locally with a typed error', async () => {
        // Default (legacy-only) server; the connection negotiates a legacy
        // version, on which server/discover does not exist — the request is
        // rejected locally before it reaches the wire. (The typed discover()
        // round-trip over HTTP completes once every modern request carries the
        // per-request _meta envelope.)
        const httpServer: HttpServer = createServer();
        const mcpServer = new McpServer({ name: 'legacy-only', version: '1.0.0' }, { capabilities: { tools: {} } });
        const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcpServer.connect(serverTransport);
        httpServer.on('request', (req, res) => void serverTransport.handleRequest(req, res));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await mcpServer.close().catch(() => {});
            await serverTransport.close().catch(() => {});
            httpServer.close();
        });

        const client = new Client({ name: 'legacy-client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        await expect(client.discover()).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
        );
    });
});
