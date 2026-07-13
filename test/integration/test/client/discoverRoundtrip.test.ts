/**
 * Discover round-trip: a pin-mode 2026 client completes `server/discover` →
 * version selection against a modern server over real HTTP, plus the
 * era-aware counter-offer end to end (a legacy client against a server whose
 * supported list carries a 2026 revision never sees a 2026 version string).
 *
 * Era is instance state on the server: an inbound `server/discover` is served
 * only by a modern-era instance (the method is physically absent from the
 * legacy registry). Production binding of modern-era instances belongs to the
 * server-side entry that classifies inbound traffic; until it lands these
 * tests bind the instance through the package-internal hook it will use.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SdkError, SdkErrorCode, setNegotiatedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core-internal';
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

    async function startServer(options: { modernEraInstance: boolean }) {
        const httpServer: HttpServer = createServer();
        // Stateless serving is per-request: each inbound request gets a fresh
        // McpServer + stateless transport pair (a stateless transport throws
        // when reused across requests). Era binding is instance state, so the
        // stand-in entry binding is re-applied to every fresh instance.
        httpServer.on('request', (req, res) => {
            void (async () => {
                const mcpServer = new McpServer(
                    { name: 'dual-era-server', version: '2.0.0' },
                    {
                        capabilities: { tools: { listChanged: true } },
                        supportedProtocolVersions: DUAL_ERA_VERSIONS,
                        instructions: 'dual era'
                    }
                );
                mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
                    content: [{ type: 'text', text }]
                }));
                const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                await mcpServer.connect(serverTransport);
                if (options.modernEraInstance) {
                    // Stand-in for the server-side entry (instance binding): mark the
                    // instance as serving the modern era so it can answer the probe.
                    setNegotiatedProtocolVersion(mcpServer.server, MODERN);
                }
                cleanups.push(async () => {
                    await mcpServer.close().catch(() => {});
                    await serverTransport.close().catch(() => {});
                });
                await serverTransport.handleRequest(req, res);
            })();
        });
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(() => {
            httpServer.close();
        });
        return baseUrl;
    }

    it('pin-mode 2026 client: server/discover → version selection, no initialize ever sent', async () => {
        const baseUrl = await startServer({ modernEraInstance: true });
        const { bodies, fetchFn } = recordingFetch();

        const client = new Client({ name: 'pin-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: fetchFn }));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getServerVersion()).toEqual({ name: 'dual-era-server', version: '2.0.0' });
        expect(client.getInstructions()).toBe('dual era');
        // The advertisement carries listChanged-class capabilities now that
        // the serving entries serve subscriptions/listen, visible end to end.
        expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });

        expect(bodies.some(b => b.includes('"initialize"'))).toBe(false);
        expect(bodies[0]).toContain('server/discover');
    });

    it('auto-mode client selects the modern era on the same server', async () => {
        const baseUrl = await startServer({ modernEraInstance: true });
        const client = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    });

    it('auto-mode against the same server NOT bound to the modern era falls back to the legacy handshake', async () => {
        // A server instance serves the legacy era until it is bound to the
        // modern one (binding is owned by the server-side entry); the probe is
        // answered -32601 and the client falls back cleanly on the same
        // connection.
        const baseUrl = await startServer({ modernEraInstance: false });
        const client = new Client({ name: 'auto-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        const result = await client.callTool({ name: 'echo', arguments: { text: 'fallback' } });
        expect(result.content).toEqual([{ type: 'text', text: 'fallback' }]);
    });

    it('a plain legacy client against a server with a dual-era list never meets a 2026 version string (counter-offer ordering, e2e)', async () => {
        const baseUrl = await startServer({ modernEraInstance: false });
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
        // Per-request stateless pair (a stateless transport throws on reuse).
        httpServer.on('request', (req, res) => {
            void (async () => {
                const mcpServer = new McpServer({ name: 'legacy-only', version: '1.0.0' }, { capabilities: { tools: {} } });
                const serverTransport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                await mcpServer.connect(serverTransport);
                cleanups.push(async () => {
                    await mcpServer.close().catch(() => {});
                    await serverTransport.close().catch(() => {});
                });
                await serverTransport.handleRequest(req, res);
            })();
        });
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(() => {
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
