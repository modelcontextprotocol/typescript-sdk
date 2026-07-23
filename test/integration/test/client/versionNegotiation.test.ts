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
 * (a silent legacy stdio server is detected by the probe — riding the
 * disposable sibling — timing out, and the client connects legacy with
 * initialize on the session child's fresh pipe).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // legacy servers do not respond to unknown pre-initialize requests at all.
    // The probe times out on the disposable sibling; the client then connects
    // legacy with initialize on the session child's fresh pipe. (On HTTP, by
    // contrast, a timeout stays a typed connect error; see the test above.)
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

    it("auto mode: the probe times out on the sibling and the client connects legacy — initialize on the session child's fresh pipe", async () => {
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

describe('stdio: sibling probe (real children)', () => {
    // The probe runs on a DISPOSABLE SIBLING spawned from the same parameters;
    // the caller's transport spawns exactly once, after the era is known. Each
    // fixture child appends "<pid> <method>" lines to a log file, so spawn
    // counts and per-child wire traffic are asserted from the file.
    const logFile = () => path.join(tmpdir(), `mcp-sibling-probe-${randomUUID()}.log`);
    const linesOf = (file: string): string[] =>
        existsSync(file)
            ? readFileSync(file, 'utf8')
                  .split('\n')
                  .filter(l => l.trim() !== '')
            : [];
    const pidsOf = (file: string): number[] => [...new Set(linesOf(file).map(l => Number(l.split(' ')[0])))];
    const methodsOf = (file: string, pid: number): string[] =>
        linesOf(file)
            .filter(l => l.startsWith(`${pid} `))
            .map(l => l.split(' ')[1]!)
            .filter(m => m !== 'spawned');
    const isAlive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    /** Line-delimited JSON-RPC child: logs every received method; `mode` picks the personality. */
    const fixture = (file: string, mode: 'rmcp' | 'modern' | 'silent' | 'rmcp-holding') => String.raw`
        const fs = require('fs');
        const log = entry => fs.appendFileSync(${JSON.stringify(file)}, process.pid + ' ' + entry + '\n');
        log('spawned');
        const MODE = ${JSON.stringify(mode)};
        if (MODE === 'rmcp-holding') {
            require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'inherit' });
        }
        let initialized = false;
        let buffer = '';
        const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
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
                if (message.method !== undefined) log(message.method);
                if (MODE === 'silent') continue;
                if (message.method === 'initialize') {
                    initialized = true;
                    send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: message.params.protocolVersion,
                            capabilities: { tools: {} },
                            serverInfo: { name: 'sibling-fixture', version: '1.0.0' }
                        }
                    });
                } else if (message.method === 'server/discover' && MODE === 'modern') {
                    send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            supportedVersions: ['2026-07-28'],
                            capabilities: { tools: {} },
                            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'sibling-fixture', version: '1.0.0' } }
                        }
                    });
                } else if (message.method === 'tools/call') {
                    // The 2026 wire requires resultType on results; the legacy wire has no such field.
                    const result = { content: [{ type: 'text', text: message.params.arguments.text }] };
                    if (MODE === 'modern') result.resultType = 'complete';
                    send({ jsonrpc: '2.0', id: message.id, result });
                } else if (!initialized && MODE !== 'modern' && message.id !== undefined) {
                    // The rmcp shape: exit on any unrecognized pre-initialize request.
                    process.exit(1);
                }
            }
        });
        process.stdin.resume();
    `;

    const spawnFixture = (file: string, mode: 'rmcp' | 'modern' | 'silent' | 'rmcp-holding') =>
        new StdioClientTransport({ command: process.execPath, args: ['-e', fixture(file, mode)] });

    it('rmcp exit-on-probe: sibling spends itself and is reaped; the session connects legacy on its only spawn and serves tools/call', async () => {
        const file = logFile();
        const transport = spawnFixture(file, 'rmcp');
        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        try {
            await client.connect(transport);

            const result = await client.callTool({ name: 'echo', arguments: { text: 'sibling' } });
            expect(result.content).toEqual([{ type: 'text', text: 'sibling' }]);

            const pids = pidsOf(file);
            expect(pids).toHaveLength(2);
            const [siblingPid, sessionPid] = pids as [number, number];
            expect(sessionPid).toBe(transport.pid);
            expect(methodsOf(file, siblingPid)).toEqual(['server/discover']);
            expect(methodsOf(file, sessionPid)).not.toContain('server/discover');
            expect(methodsOf(file, sessionPid)).toContain('initialize');
            await vi.waitFor(() => expect(isAlive(siblingPid)).toBe(false));
        } finally {
            await client.close();
        }
    }, 15_000);

    it('modern server: the session adopts the sibling verdict — its wire carries neither server/discover nor initialize', async () => {
        const file = logFile();
        const transport = spawnFixture(file, 'modern');
        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        try {
            await client.connect(transport);
            expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
            expect(client.getServerVersion()?.name).toBe('sibling-fixture');

            const result = await client.callTool({ name: 'echo', arguments: { text: 'modern' } });
            expect(result.content).toEqual([{ type: 'text', text: 'modern' }]);

            const pids = pidsOf(file);
            expect(pids).toHaveLength(2);
            const [siblingPid, sessionPid] = pids as [number, number];
            expect(methodsOf(file, siblingPid)).toEqual(['server/discover']);
            // Byte-trace: the verdict was adopted — the session never probed and
            // never ran the legacy handshake.
            expect(methodsOf(file, sessionPid)).not.toContain('server/discover');
            expect(methodsOf(file, sessionPid)).not.toContain('initialize');
            await vi.waitFor(() => expect(isAlive(siblingPid)).toBe(false));
        } finally {
            await client.close();
        }
    }, 15_000);

    it('caller close() mid-probe aborts promptly: typed error, the session child is never spawned, the sibling is reaped', async () => {
        const file = logFile();
        const transport = spawnFixture(file, 'silent');
        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });

        const pending = client.connect(transport);
        pending.catch(() => {});
        await vi.waitFor(() => expect(pidsOf(file)).toHaveLength(1));

        await transport.close();

        const rejection = await pending.then(
            () => {},
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((rejection as SdkError).message).toMatch(/transport was closed during the server\/discover probe/);
        // The session child was never spawned, and the sibling is reaped.
        expect(transport.pid).toBeNull();
        expect(pidsOf(file)).toHaveLength(1);
        await vi.waitFor(() => expect(isAlive(pidsOf(file)[0]!)).toBe(false));
    }, 15_000);

    it("a pre-set onclose observer survives a failed pin negotiation: a restarted life's close still reaches it", async () => {
        // The sibling design keeps the session transport's handlers untouched
        // during the probe (the window opens on the sibling, which has none),
        // so a failed negotiation must leave the caller's observer fully
        // armed: after the caller restarts the transport, its life's close is
        // genuine and must be delivered. (On the real StdioClientTransport,
        // close() never re-fires onclose — delivery comes only from the
        // child's own close event — so any leftover one-shot suppression
        // would swallow exactly this event.)
        const file = logFile();
        const transport = spawnFixture(file, 'rmcp');
        let closes = 0;
        transport.onclose = () => {
            closes++;
        };
        const client = new Client({ name: 'neg-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

        await expect(client.connect(transport)).rejects.toThrow(/no fallback in pin mode/);
        // The session child was never spawned, so its observer saw nothing yet.
        expect(transport.pid).toBeNull();
        expect(closes).toBe(0);

        // The caller restarts the transport: its first real life. Closing it
        // makes the child exit — that close event must reach the observer.
        await transport.start();
        expect(transport.pid).not.toBeNull();
        await transport.close();
        await vi.waitFor(() => expect(closes).toBe(1));
    }, 15_000);

    it('a helper holding the probe child’s pipes defers the close past the probe window: the timeout row still lands legacy and the session works', async () => {
        const file = logFile();
        const transport = spawnFixture(file, 'rmcp-holding');
        const client = new Client(
            { name: 'neg-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 800 } } }
        );
        try {
            await client.connect(transport);
            const result = await client.callTool({ name: 'echo', arguments: { text: 'held' } });
            expect(result.content).toEqual([{ type: 'text', text: 'held' }]);
            const pids = pidsOf(file);
            expect(pids).toHaveLength(2);
            await vi.waitFor(() => expect(isAlive(pids[0]!)).toBe(false));
        } finally {
            await client.close();
        }
    }, 15_000);
});
