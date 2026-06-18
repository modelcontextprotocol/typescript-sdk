/**
 * Real-pipe dual-era stdio coverage for the connection-pinned `serveStdio`
 * entry: the fixture server (`__fixtures__/dualEraStdioServer.ts`, one
 * `McpServer` factory behind `serveStdio`) is spawned as a real child process
 * — once per connection — and driven over its stdio pipe by
 *
 * - a plain 2025 client (the `initialize` vertical, served exactly as today,
 *   with the era gate staying vocabulary-clean on that connection),
 * - the negotiating client in auto mode (the 2026-07-28 vertical:
 *   `server/discover` on the pipe, then list → call with the per-request
 *   envelope; a late claim-less `initialize` on the pinned connection answers
 *   the version error naming the supported revisions), and
 * - a raw probe-then-fallback exchange (`server/discover` answered, then the
 *   client falls back to `initialize` on the same pipe and is served a normal
 *   2025 session by a fresh legacy instance).
 *
 * Stdio behavior has no conformance harness (upstream conformance issue #258);
 * this SDK e2e suite is its referee.
 */
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

const FIXTURES_DIR = path.resolve(__dirname, '../__fixtures__');
const MODERN = '2026-07-28';

const FORBIDDEN_2026_VOCABULARY = ['2026', 'discover', 'envelope', 'modern', 'era', '_meta', 'io.modelcontextprotocol', 'resultType'];

const modernEnvelope = (clientName: string) => ({
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: clientName, version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
});

function spawnFixtureTransport(): StdioClientTransport {
    return new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', 'dualEraStdioServer.ts'],
        cwd: FIXTURES_DIR
    });
}

/** Records every message the server writes onto the pipe (without detaching the client). */
function recordInbound(transport: StdioClientTransport): JSONRPCMessage[] {
    const inbound: JSONRPCMessage[] = [];
    const original = transport.onmessage;
    transport.onmessage = (message, extra) => {
        inbound.push(message);
        original?.(message, extra);
    };
    return inbound;
}

/** Records every message the client writes onto the pipe. */
function recordOutbound(transport: StdioClientTransport): JSONRPCMessage[] {
    const outbound: JSONRPCMessage[] = [];
    const originalSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
        outbound.push(message);
        return originalSend(message, options);
    };
    return outbound;
}

/** Sends a raw JSON-RPC request on the live pipe and resolves with the matching response. */
async function rawRequest(transport: StdioClientTransport, inbound: JSONRPCMessage[], request: JSONRPCMessage): Promise<JSONRPCMessage> {
    const id = (request as { id: string | number }).id;
    const seen = inbound.length;
    await transport.send(request);
    return vi.waitFor(
        () => {
            const match = inbound.slice(seen).find(message => (message as { id?: string | number }).id === id);
            if (!match) throw new Error('no response yet');
            return match;
        },
        { timeout: 5000 }
    );
}

describe('serveStdio over a real child-process pipe (one connection per spawned process)', () => {
    vi.setConfig({ testTimeout: 30_000 });

    it('legacy-opening connection: a plain 2025 client is served via initialize, and the connection stays vocabulary-clean', async () => {
        const transport = spawnFixtureTransport();
        const client = new Client({ name: 'legacy-pipe-client', version: '1.0.0' });
        // Raw writes below produce responses the protocol layer does not track.
        client.onerror = () => {};

        try {
            await client.connect(transport);
            const inbound = recordInbound(transport);

            // The 2025 vertical, byte-shape checks included.
            expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            const tools = await client.listTools();
            expect(tools.tools.map(tool => tool.name)).toEqual(['echo']);
            const result = await client.callTool({ name: 'echo', arguments: { text: 'over the real pipe' } });
            expect(result.content).toEqual([{ type: 'text', text: 'over the real pipe' }]);
            expect(JSON.stringify(inbound)).not.toContain('resultType');

            // Era-gate negative on this 2025-pinned connection: a claim-less
            // server/discover answers a plain −32601 with zero 2026 vocabulary.
            const gate = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'raw-gate-1',
                method: 'server/discover',
                params: {}
            });
            const error = (gate as { error: { code: number; message: string; data?: unknown } }).error;
            expect(error.code).toBe(-32_601);
            expect(error.message).toBe('Method not found');
            expect(error.data).toBeUndefined();
            const serialized = JSON.stringify(error).toLowerCase();
            for (const term of FORBIDDEN_2026_VOCABULARY) {
                expect(serialized).not.toContain(term.toLowerCase());
            }
        } finally {
            await client.close();
        }
    });

    it('modern-opening connection: the auto-negotiating client reaches 2026-07-28 via server/discover, the connection pins modern, and a late initialize is rejected with the supported list', async () => {
        const transport = spawnFixtureTransport();
        const outbound = recordOutbound(transport);
        const client = new Client({ name: 'modern-pipe-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
        client.onerror = () => {};

        try {
            await client.connect(transport);
            const inbound = recordInbound(transport);

            // 2026 negotiated via discover on the pipe — no initialize was ever written.
            expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
            expect(outbound.some(message => (message as { method?: string }).method === 'initialize')).toBe(false);
            expect((outbound[0] as { method?: string }).method).toBe('server/discover');

            // Modern vertical: list → call, every request carrying the per-request envelope.
            // (Attaching it explicitly is the documented stop-gap until automatic
            // per-request envelope emission lands client-side.)
            const envelope = modernEnvelope('modern-pipe-client');
            const modernList = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'raw-modern-list',
                method: 'tools/list',
                params: { _meta: envelope }
            });
            const modernListResult = (modernList as { result?: { tools?: Array<{ name: string }>; resultType?: string } }).result;
            expect(modernListResult?.tools?.map(tool => tool.name)).toEqual(['echo']);
            expect(modernListResult?.resultType).toBe('complete');

            const result = await client.request({
                method: 'tools/call',
                params: { name: 'echo', arguments: { text: 'modern leg' }, _meta: envelope }
            });
            expect(result.content).toEqual([{ type: 'text', text: 'modern leg' }]);

            // The connection is pinned to the 2026 era: a late claim-less
            // initialize is answered with the version error naming the
            // supported revisions, never served as a legacy handshake.
            const lateInitialize = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'raw-late-initialize',
                method: 'initialize',
                params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'late', version: '0' } }
            });
            const lateError = (lateInitialize as { error: { code: number; data?: { supported?: string[] } } }).error;
            expect(lateError.code).toBe(-32_004);
            expect(lateError.data?.supported).toContain(MODERN);
        } finally {
            await client.close();
        }
    });

    it('probe-then-fallback connection: server/discover is answered, then an initialize on the same pipe is served a normal 2025 session', async () => {
        const transport = spawnFixtureTransport();
        const inbound: JSONRPCMessage[] = [];
        transport.onmessage = message => void inbound.push(message);
        transport.onerror = () => {};

        try {
            await transport.start();

            // The probe is answered by the optimistically built modern instance.
            const discover = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'probe-1',
                method: 'server/discover',
                params: { _meta: modernEnvelope('fallback-pipe-client') }
            });
            const discoverResult = (discover as { result?: { supportedVersions?: string[]; resultType?: string } }).result;
            expect(discoverResult?.supportedVersions).toEqual([MODERN]);
            expect(discoverResult?.resultType).toBe('complete');

            // The client shares no modern revision and falls back to the 2025
            // handshake on the same connection: a fresh legacy instance serves it.
            const init = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'fallback-init',
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: { name: 'fallback-pipe-client', version: '1.0.0' }
                }
            });
            const initResult = (init as { result?: { protocolVersion?: string } }).result;
            expect(initResult?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
            expect(JSON.stringify(init)).not.toContain('resultType');

            await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

            // The legacy session works end to end after the fallback.
            const list = await rawRequest(transport, inbound, { jsonrpc: '2.0', id: 'fallback-list', method: 'tools/list', params: {} });
            const listResult = (list as { result?: { tools?: Array<{ name: string }>; resultType?: string } }).result;
            expect(listResult?.tools?.map(tool => tool.name)).toEqual(['echo']);
            expect(listResult?.resultType).toBeUndefined();
        } finally {
            await transport.close();
        }
    });
});
