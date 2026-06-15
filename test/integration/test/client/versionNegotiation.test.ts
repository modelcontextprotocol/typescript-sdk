/**
 * Wire-real version negotiation fixtures: the probe against REAL deployed-shape
 * servers over real HTTP.
 *
 * First-contact wire shapes (both deployment flavors):
 * - stateless servers answer the probe 400/-32000 with the byte-exact
 *   "Unsupported protocol version" literal (version header checked, no session),
 * - stateful servers answer 400/-32000 session-required free-text (session is
 *   checked BEFORE version).
 *
 * Plus: structural fallback hygiene (the auto client's post-probe traffic is
 * byte-identical to a plain legacy client's, zero 2026 headers), the typed
 * connect errors for outage and HTTP timeout, and the stdio timeout fallback
 * (a silent legacy stdio server is detected by the probe timing out and the
 * client falls back to initialize on the same pipe).
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

/** A fetch wrapper recording every request our client puts on the wire (URL, headers, body) and the raw response (status, body). */
function recordingFetch() {
    const calls: Array<{
        method: string;
        headers: Record<string, string>;
        body: string | undefined;
        status: number;
        responseBody: string;
    }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of new Headers(init?.headers).entries()) {
            headers[key.toLowerCase()] = value;
        }
        const response = await fetch(input, init);
        const clone = response.clone();
        const responseBody = await clone.text().catch(() => '');
        calls.push({
            method: init?.method ?? 'GET',
            headers,
            body: typeof init?.body === 'string' ? init.body : undefined,
            status: response.status,
            responseBody
        });
        return response;
    };
    return { calls, fetchFn };
}

const NEGOTIATION_HEADERS = ['mcp-protocol-version', 'mcp-method', 'mcp-name'] as const;

async function setupLegacyServer(stateful: boolean) {
    const httpServer: Server = createServer();
    const mcpServer = new McpServer({ name: 'deployed-2025-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    const serverTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: stateful ? () => randomUUID() : undefined
    });
    await mcpServer.connect(serverTransport);
    httpServer.on('request', (req, res) => void serverTransport.handleRequest(req, res));
    const baseUrl = await listenOnRandomPort(httpServer);
    return { httpServer, mcpServer, serverTransport, baseUrl };
}

describe('version negotiation against real legacy servers (wire-real first-contact shapes)', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    async function startLegacy(stateful: boolean) {
        const setup = await setupLegacyServer(stateful);
        cleanups.push(async () => {
            await setup.mcpServer.close().catch(() => {});
            await setup.serverTransport.close().catch(() => {});
            setup.httpServer.close();
        });
        return setup;
    }

    it('stateless deployment: the probe meets the 400/-32000 "Unsupported protocol version" literal, then falls back byte-clean', async () => {
        const { baseUrl } = await startLegacy(false);
        const { calls, fetchFn } = recordingFetch();

        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        const transport = new StreamableHTTPClientTransport(baseUrl, { fetch: fetchFn });
        await client.connect(transport);
        cleanups.push(() => client.close());

        // First contact: the probe POST (body-derived 2026 headers).
        const probe = calls[0]!;
        expect(probe.headers['mcp-protocol-version']).toBe('2026-07-28');
        expect(probe.headers['mcp-method']).toBe('server/discover');
        // Wire-real shape #1 — the deployed-fleet literal (Q10-L1; consumed as a fixture only).
        expect(probe.status).toBe(400);
        const probeBody = JSON.parse(probe.responseBody) as { error: { code: number; message: string } };
        expect(probeBody.error.code).toBe(-32_000);
        expect(probeBody.error.message).toContain('Bad Request: Unsupported protocol version: 2026-07-28');
        expect(probeBody.error.message).toContain('supported versions:');

        // Conservative fallback on the same connection.
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');

        // Fallback hygiene: ZERO 2026 headers on every post-probe request.
        for (const call of calls.slice(1)) {
            expect(call.headers['mcp-method']).toBeUndefined();
            expect(call.headers['mcp-name']).toBeUndefined();
            const version = call.headers['mcp-protocol-version'];
            if (version !== undefined) {
                expect(version < '2026').toBe(true);
            }
            expect(call.body ?? '').not.toContain('2026-07-28');
        }

        // The legacy era works end to end.
        const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('stateful deployment: the probe meets 400/-32000 session-required free-text (session checked before version), then falls back', async () => {
        const { baseUrl } = await startLegacy(true);
        const { calls, fetchFn } = recordingFetch();

        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        const transport = new StreamableHTTPClientTransport(baseUrl, { fetch: fetchFn });
        await client.connect(transport);
        cleanups.push(() => client.close());

        // Wire-real shape #2 — stateful servers reject pre-init non-initialize
        // POSTs before ever looking at the version header.
        const probe = calls[0]!;
        expect(probe.status).toBe(400);
        const probeBody = JSON.parse(probe.responseBody) as { error: { code: number; message: string } };
        expect(probeBody.error.code).toBe(-32_000);
        expect(probeBody.error.message).toBe('Bad Request: Server not initialized');

        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        const result = await client.callTool({ name: 'echo', arguments: { text: 'stateful' } });
        expect(result.content).toEqual([{ type: 'text', text: 'stateful' }]);
    });

    it('diff-asserted fallback ≡ this client’s own plain legacy connect under identical ClientOptions', async () => {
        const { baseUrl } = await startLegacy(false);

        const auto = recordingFetch();
        const autoClient = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        await autoClient.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: auto.fetchFn }));
        cleanups.push(() => autoClient.close());
        await autoClient.callTool({ name: 'echo', arguments: { text: 'x' } });

        const plain = recordingFetch();
        const plainClient = new Client({ name: 'neg-client', version: '1.0.0' });
        await plainClient.connect(new StreamableHTTPClientTransport(baseUrl, { fetch: plain.fetchFn }));
        cleanups.push(() => plainClient.close());
        await plainClient.callTool({ name: 'echo', arguments: { text: 'x' } });

        // Drop the probe exchange; everything after it must be identical to the
        // plain client: same POST bodies (including the initialize body version)
        // and the same headers (no clearing artifacts, no extras).
        const autoPosts = auto.calls.filter(c => c.method === 'POST').slice(1);
        const plainPosts = plain.calls.filter(c => c.method === 'POST');
        expect(autoPosts.length).toBe(plainPosts.length);
        for (const [i, plainPost] of plainPosts.entries()) {
            expect(autoPosts[i]!.body).toBe(plainPost!.body);
            expect(autoPosts[i]!.headers).toEqual(plainPost!.headers);
            for (const header of NEGOTIATION_HEADERS) {
                if (header === 'mcp-protocol-version') continue; // legacy value allowed post-initialize
                expect(autoPosts[i]!.headers[header]).toBeUndefined();
            }
        }
    });
});

describe('typed connect errors (Q12) over real sockets', () => {
    it('network outage (nothing listening): typed connect error, never a legacy verdict', async () => {
        // Reserve a port, then close it so nothing is listening.
        const placeholder = createServer();
        const url = await listenOnRandomPort(placeholder);
        await new Promise<void>(resolve => placeholder.close(() => resolve()));

        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        const transport = new StreamableHTTPClientTransport(url);

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
    });

    it('probe timeout: typed timeout error, no initialize ever sent', async () => {
        // A server that accepts the request and never responds.
        const hang = createServer(() => {
            /* never answer */
        });
        const url = await listenOnRandomPort(hang);

        const { calls, fetchFn } = recordingFetch();
        const client = new Client(
            { name: 'neg-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 300 } } }
        );
        const transport = new StreamableHTTPClientTransport(url, { fetch: fetchFn });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
        );

        // Probe POSTs only — zero initialize POSTs.
        const posts = calls.filter(c => c.method === 'POST');
        expect(posts.every(c => c.headers['mcp-method'] === 'server/discover')).toBe(true);
        expect(posts.every(c => (c.body ?? '').includes('server/discover'))).toBe(true);
        expect(calls.some(c => (c.body ?? '').includes('"initialize"'))).toBe(false);

        await new Promise<void>(resolve => hang.close(() => resolve()));
        await new Promise(resolve => setTimeout(resolve, 50));
    }, 15_000);
});

describe('stdio: silent legacy server (probe timeout fallback)', () => {
    // The stdio transport's backward-compatibility rule: a probe that gets no
    // response within a reasonable timeout indicates a legacy server — some
    // legacy servers do not respond to unknown pre-initialize requests at all
    // — and the client falls back to initialize on the same pipe. (On HTTP,
    // by contrast, a timeout stays a typed connect error; see the test above.)
    const SILENT_LEGACY_SERVER_SCRIPT = String.raw`
        let buffer = '';
        process.stdin.on('data', chunk => {
            buffer += chunk.toString();
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (line.trim() === '') continue;
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                // A legacy server that simply ignores unknown pre-initialize
                // requests (server/discover gets NO reply at all) but answers
                // the initialize handshake normally.
                if (message.method === 'initialize' && message.id !== undefined) {
                    process.stdout.write(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: {
                                protocolVersion: '2025-11-25',
                                capabilities: {},
                                serverInfo: { name: 'silent-legacy-stdio-server', version: '1.0.0' }
                            }
                        }) + '\n'
                    );
                }
            }
        });
    `;

    it('auto mode: the probe times out, the client falls back to initialize on the same pipe and connects on the legacy era', async () => {
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: ['-e', SILENT_LEGACY_SERVER_SCRIPT]
        });
        const client = new Client(
            { name: 'neg-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 500 } } }
        );

        try {
            await client.connect(transport);
            expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
            expect(client.getServerVersion()?.name).toBe('silent-legacy-stdio-server');
        } finally {
            await client.close();
        }
    }, 15_000);
});
