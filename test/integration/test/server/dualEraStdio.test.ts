/**
 * Real-pipe dual-era stdio coverage: the fixture server
 * (`__fixtures__/dualEraStdioServer.ts`, `eraSupport: 'dual-era'`, unchanged
 * `StdioServerTransport`) is spawned as a real child process and driven over
 * its stdio pipe by
 *
 * - a plain 2025 client (the `initialize` vertical, served exactly as today),
 * - the negotiating client in auto mode (the 2026-07-28 vertical:
 *   `server/discover` on the pipe, then list → call with the per-request
 *   envelope), and
 * - the long-lived era-gate negative on one connection: a legacy-classified
 *   `server/discover` answers a plain −32601 with zero 2026 vocabulary, while
 *   the same connection keeps serving both eras.
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

describe('dual-era stdio server over a real child-process pipe', () => {
    vi.setConfig({ testTimeout: 30_000 });

    it('legacy vertical: a plain 2025 client is served via initialize, and the era gate stays vocabulary-clean on the same connection', async () => {
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

            // Era-gate negative on the SAME connection: a legacy-classified
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

    it('modern vertical: the auto-negotiating client reaches 2026-07-28 via server/discover on the pipe and both eras serve on one connection', async () => {
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
            const envelope = {
                [PROTOCOL_VERSION_META_KEY]: MODERN,
                [CLIENT_INFO_META_KEY]: { name: 'modern-pipe-client', version: '1.0.0' },
                [CLIENT_CAPABILITIES_META_KEY]: {}
            };
            // The list leg is asserted at the wire level: the 2026 wire schema
            // for cacheable list results requires the ttlMs/cacheScope stamps,
            // whose server-side stamping ships with the result-stamping
            // milestone — the client-side typed decode of tools/list on the
            // modern era completes once that lands.
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

            // Both eras concurrently on ONE connection: a raw legacy (envelope-less)
            // request on the same pipe is served on the 2025 era…
            const legacyList = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'raw-legacy-list',
                method: 'tools/list',
                params: {}
            });
            const legacyResult = (legacyList as { result?: { tools?: Array<{ name: string }>; resultType?: string } }).result;
            expect(legacyResult?.tools?.map(tool => tool.name)).toEqual(['echo']);
            expect(legacyResult?.resultType).toBeUndefined();

            // …while the era-gate negative holds on the same connection too.
            const gate = await rawRequest(transport, inbound, {
                jsonrpc: '2.0',
                id: 'raw-gate-2',
                method: 'subscriptions/listen',
                params: {}
            });
            const error = (gate as { error: { code: number; message: string; data?: unknown } }).error;
            expect(error.code).toBe(-32_601);
            expect(error.message).toBe('Method not found');
            expect(error.data).toBeUndefined();
        } finally {
            await client.close();
        }
    });
});
