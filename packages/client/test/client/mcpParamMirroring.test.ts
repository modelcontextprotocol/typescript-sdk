/**
 * SEP-2243 client-side `Mcp-Param-*` mirroring (protocol revision 2026-07-28).
 *
 * Covers: `tools/list` exclusion of constraint-violating definitions; per-call
 * `Mcp-Param-*` header construction from the response-cache's `tools/list`
 * entry and the `toolDefinition` escape hatch; era-parity (legacy `callTool`
 * byte-untouched); stdio MAY-ignore (no headers on a single-channel
 * transport); the one-evict-refetch-retry on `HEADER_MISMATCH`.
 */
import type { JSONRPCMessage, JSONRPCRequest, Tool, TransportSendOptions } from '@modelcontextprotocol/core';
import { encodeMcpParamValue, HEADER_MISMATCH_ERROR_CODE, InMemoryTransport, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import { Client } from '../../src/client/client.js';
import { InMemoryResponseCacheStore, type ResponseCacheStore } from '../../src/client/responseCache.js';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp.js';

const MODERN = '2026-07-28';

const REGION_TOOL: Tool = {
    name: 'route',
    inputSchema: {
        type: 'object',
        properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } }
    }
};

const INVALID_TOOL: Tool = {
    name: 'broken',
    inputSchema: { type: 'object', properties: { a: { type: 'object', 'x-mcp-header': 'Data' } } }
};

interface Scripted {
    clientTx: InMemoryTransport;
    serverTx: InMemoryTransport;
    /** Headers passed via TransportSendOptions for each tools/call (undefined when none). */
    callHeaders: Array<Record<string, string> | undefined>;
    listCount: () => number;
}

async function scriptedModernServer(pages: Tool[][], rejectFirstCall = false): Promise<Scripted> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const callHeaders: Array<Record<string, string> | undefined> = [];
    let calls = 0;
    let lists = 0;

    // Tap the client→server channel to observe TransportSendOptions.headers
    // (InMemoryTransport ignores it; this is the seam under test).
    const realSend = clientTx.send.bind(clientTx);
    clientTx.send = (m: JSONRPCMessage, opts?: TransportSendOptions): Promise<void> => {
        if ((m as JSONRPCRequest).method === 'tools/call') {
            callHeaders.push(opts?.headers ? { ...opts.headers } : undefined);
        }
        return realSend(m, opts);
    };

    serverTx.onmessage = m => {
        const r = m as JSONRPCRequest;
        if (r.id === undefined) return;
        if (r.method === 'server/discover') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    supportedVersions: [MODERN],
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'scripted', version: '1.0.0' }
                }
            });
        } else if (r.method === 'tools/list') {
            lists++;
            const cursor = (r.params as { cursor?: string } | undefined)?.cursor;
            const idx = cursor === undefined ? 0 : Number(cursor);
            const next = idx + 1 < pages.length ? String(idx + 1) : undefined;
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    ttlMs: 60_000,
                    cacheScope: 'public',
                    tools: pages[idx] ?? [],
                    ...(next !== undefined && { nextCursor: next })
                }
            });
        } else if (r.method === 'tools/call') {
            calls++;
            if (rejectFirstCall && calls === 1) {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: r.id,
                    error: { code: HEADER_MISMATCH_ERROR_CODE, message: 'Bad Request: the request headers and body disagree' }
                });
            } else {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: r.id,
                    result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] }
                });
            }
        }
    };
    await serverTx.start();
    return { clientTx, serverTx, callHeaders, listCount: () => lists };
}

function modernClient(store?: InMemoryResponseCacheStore): Client {
    return new Client(
        { name: 'param-mirror-client', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: MODERN } }, ...(store && { responseCacheStore: store }) }
    );
}

describe('SEP-2243 Mcp-Param-* mirroring (modern era)', () => {
    it('listTools() and the cached tools/list entry exclude constraint-violating x-mcp-header tools and warn', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[REGION_TOOL, INVALID_TOOL]]);
        const client = modernClient(store);
        await client.connect(clientTx);

        // Auto-aggregate listTools() filters and writes the CACHED aggregate
        // (the entry mirroring reads).
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['route']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("excluding tool 'broken'"));
        expect((store.get({ method: 'tools/list' })?.value as { tools: Tool[] }).tools.map(t => t.name)).toEqual(['route']);
        // The explicit-cursor per-page path is filtered too (the spec's MUST
        // has no carve-out for paginated reads).
        const page = await client.listTools({ cursor: '0' });
        expect(page.tools.map(t => t.name)).toEqual(['route']);
        warn.mockRestore();
    });

    it('callTool() passes Mcp-Param-* via TransportSendOptions.headers from the cached tools/list entry; null/absent are omitted', async () => {
        const { clientTx, callHeaders } = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient();
        await client.connect(clientTx);
        await client.listTools();

        await client.callTool({ name: 'route', arguments: { region: 'us-west1', query: 'x' } });
        await client.callTool({ name: 'route', arguments: { region: null, query: 'x' } as Record<string, unknown> });

        expect(callHeaders[0]).toEqual({ 'Mcp-Param-Region': 'us-west1' });
        expect(callHeaders[1]).toBeUndefined();
    });

    it('callTool() uses the toolDefinition escape hatch without a prior tools/list', async () => {
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient();
        await client.connect(clientTx);

        await client.callTool({ name: 'route', arguments: { region: 'eu' } }, { toolDefinition: REGION_TOOL });
        expect(listCount()).toBe(0);
        expect(callHeaders[0]).toEqual({ 'Mcp-Param-Region': 'eu' });
    });

    it('callTool() evicts the tools/list entry, refetches once and retries on a HEADER_MISMATCH rejection (stale-cache path)', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[REGION_TOOL]], /* rejectFirstCall */ true);
        const client = modernClient(store);
        await client.connect(clientTx);
        // Seed a STALE entry (no declarations) so callTool reads it and the
        // first send carries no param headers — server rejects
        // HEADER_MISMATCH, client evicts, refetches via listTools()
        // (the live REGION_TOOL), and retries with the headers.
        store.set({ method: 'tools/list' }, { value: { tools: [{ name: 'route', inputSchema: { type: 'object', properties: {} } }] } });

        const result = await client.callTool({ name: 'route', arguments: { region: 'ap' } });
        expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok' });
        expect(listCount()).toBe(1);
        expect(callHeaders).toEqual([undefined, { 'Mcp-Param-Region': 'ap' }]);
        // The recovery refetch wrote a fresh cache entry (REGION_TOOL, with the declaration).
        expect((store.get({ method: 'tools/list' })?.value as { tools: Tool[] }).tools[0]?.inputSchema.properties).toHaveProperty('region');
    });

    it('callTool() with a cold cache issues NO tools/list and sends without Mcp-Param-* headers (cache reads only)', async () => {
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient();
        await client.connect(clientTx);

        const result = await client.callTool({ name: 'route', arguments: { region: 'ap' } });
        expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok' });
        // No on-demand populate: callTool reads the cache directly. Cold ⇒
        // proceed without headers (the spec's "client SHOULD send without
        // custom headers" guidance) — the only callTool-driven tools/list is
        // the HEADER_MISMATCH recovery path.
        expect(listCount()).toBe(0);
        expect(callHeaders).toEqual([undefined]);
    });

    it('a custom store whose get() rejects is routed to onerror and callTool degrades (no headers, no validation, result preserved)', async () => {
        const store = new InMemoryResponseCacheStore();
        (store as ResponseCacheStore).get = () => Promise.reject(new Error('redis down'));
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient(store);
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        await client.connect(clientTx);

        // The pre-send mirroring read AND the post-success validator read both
        // hit a rejecting `get()`. Neither aborts the call: the request goes
        // out without `Mcp-Param-*` headers (cold-cache posture), the
        // server-side result is returned, and both store failures surface via
        // `onerror`. The post-success guard is the critical one — a store
        // failure after the server has executed the call must never surface
        // as a `callTool()` rejection (duplicate-execution hazard on retry).
        const result = await client.callTool({ name: 'route', arguments: { region: 'ap' } });
        expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok' });
        expect(callHeaders).toEqual([undefined]);
        expect(listCount()).toBe(0);
        expect(errors.map(e => e.message)).toEqual(['redis down', 'redis down']);
    });

    it('a paginating server: the cached aggregate holds every page and a page-2 x-mcp-header tool mirrors on the first call', async () => {
        const PAGE1: Tool = { name: 'echo', inputSchema: { type: 'object', properties: {} } };
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[PAGE1], [REGION_TOOL]]);
        const client = modernClient();
        await client.connect(clientTx);

        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['echo', 'route']);
        expect(listCount()).toBe(2);

        await client.callTool({ name: 'route', arguments: { region: 'us-west1' } });
        expect(callHeaders[0]).toEqual({ 'Mcp-Param-Region': 'us-west1' });
    });

    it('HEADER_MISMATCH recovery refetch walks every page; a page-2 x-mcp-header tool is recovered (stale-cache path)', async () => {
        const PAGE1: Tool = { name: 'echo', inputSchema: { type: 'object', properties: {} } };
        const store = new InMemoryResponseCacheStore();
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[PAGE1], [REGION_TOOL]], /* rejectFirstCall */ true);
        const client = modernClient(store);
        await client.connect(clientTx);
        // Seed a STALE entry so the first send goes without headers; the
        // recovery refetch (via listTools()) then walks BOTH pages.
        store.set({ method: 'tools/list' }, { value: { tools: [PAGE1] } });

        const result = await client.callTool({ name: 'route', arguments: { region: 'us-west1' } });
        expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok' });
        // The recovery refetch walked both pages.
        expect(listCount()).toBe(2);
        expect(callHeaders).toEqual([undefined, { 'Mcp-Param-Region': 'us-west1' }]);
        // A follow-up call still mirrors from the cached entry (no extra list).
        await client.callTool({ name: 'route', arguments: { region: 'eu' } });
        expect(callHeaders[2]).toEqual({ 'Mcp-Param-Region': 'eu' });
        expect(listCount()).toBe(2);
    });

    it('notifications/tools/list_changed evicts the cached entry; the next callTool reads cold (no auto-refetch)', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, serverTx, callHeaders, listCount } = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient(store);
        await client.connect(clientTx);
        // Seed a STALE entry (no declarations); list_changed evicts it; the
        // next callTool reads cold and sends without headers — callTool
        // never refetches on its own.
        store.set({ method: 'tools/list' }, { value: { tools: [{ name: 'route', inputSchema: { type: 'object', properties: {} } }] } });
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        expect(store.get({ method: 'tools/list' })).toBeUndefined();

        const result = await client.callTool({ name: 'route', arguments: { region: 'us' } });
        expect(result.content?.[0]).toEqual({ type: 'text', text: 'ok' });
        expect(listCount()).toBe(0);
        expect(callHeaders).toEqual([undefined]);
    });

    it('_resetConnectionState() clears the response cache (close → reconnect → no stale scan)', async () => {
        const a = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient();
        await client.connect(a.clientTx);
        await client.listTools();
        await client.close();

        const b = await scriptedModernServer([[{ name: 'route', inputSchema: { type: 'object', properties: {} } }]]);
        await client.connect(b.clientTx);

        await client.callTool({ name: 'route', arguments: { region: 'us' } });
        // The cache from A was cleared on close → callTool reads cold against
        // server B → no Mcp-Param-* headers (no stale scan from A's entry),
        // and no callTool-driven tools/list either.
        expect(b.listCount()).toBe(0);
        expect(b.callHeaders[0]).toBeUndefined();
    });
});

describe('SEP-2243 era parity / stdio exemption', () => {
    it('legacy-era callTool() is byte-untouched: zero tools/list requests, no headers, no exclusion', async () => {
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        const callHeaders: Array<Record<string, string> | undefined> = [];
        const sentMethods: string[] = [];
        const realSend = clientTx.send.bind(clientTx);
        clientTx.send = (m: JSONRPCMessage, opts?: TransportSendOptions): Promise<void> => {
            if ('method' in m) sentMethods.push((m as JSONRPCRequest).method);
            if ((m as JSONRPCRequest).method === 'tools/call') callHeaders.push(opts?.headers ? { ...opts.headers } : undefined);
            return realSend(m, opts);
        };
        serverTx.onmessage = m => {
            const r = m as JSONRPCRequest;
            if (r.id === undefined) return;
            if (r.method === 'initialize') {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: r.id,
                    result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } }
                });
            } else if (r.method === 'tools/list') {
                void serverTx.send({ jsonrpc: '2.0', id: r.id, result: { tools: [REGION_TOOL, INVALID_TOOL] } });
            } else if (r.method === 'tools/call') {
                void serverTx.send({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'ok' }] } });
            }
        };
        await serverTx.start();

        const client = new Client({ name: 'legacy', version: '1' });
        await client.connect(clientTx);
        expect(client.getProtocolEra()).toBe('legacy');

        // PIN: a legacy/stdio callTool issues ZERO tools/list requests —
        // callTool never auto-populates the cache; mirroring/validation read
        // it directly (cold ⇒ skip).
        await client.callTool({ name: 'route', arguments: { region: 'us' } });
        expect(sentMethods.filter(m => m === 'tools/list')).toEqual([]);
        expect(callHeaders).toEqual([undefined]);

        const { tools } = await client.listTools();
        // No exclusion on the legacy era — both tools present.
        expect(tools.map(t => t.name)).toEqual(['route', 'broken']);
    });

    it('modern-era stdio callTool() issues zero tools/list requests (cold cache, mirroring inactive)', async () => {
        // Mirrors the legacy pin above but on the modern era over a
        // single-channel transport: even though `mirroringActive` is true,
        // callTool reads the cache directly and sends nothing extra.
        const { clientTx, callHeaders, listCount } = await scriptedModernServer([[REGION_TOOL]]);
        const client = modernClient();
        await client.connect(clientTx);

        await client.callTool({ name: 'route', arguments: { region: 'us' } });
        expect(listCount()).toBe(0);
        expect(callHeaders).toEqual([undefined]);
    });

    it('stdio MAY-ignore: a single-channel transport drops TransportSendOptions.headers', async () => {
        // InMemoryTransport stands in for stdio here: like the stdio transport
        // it shares a single channel and ignores per-request HTTP headers.
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        let sawHeaders: unknown;
        serverTx.onmessage = (_m, extra) => {
            sawHeaders = (extra as { headers?: unknown } | undefined)?.headers;
        };
        await clientTx.start();
        await (clientTx as { send: (m: JSONRPCMessage, opts?: TransportSendOptions) => Promise<void> }).send(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } },
            { headers: { 'Mcp-Param-Region': 'us' } }
        );
        expect(sawHeaders).toBeUndefined();
    });
});

describe('SEP-2243 Streamable HTTP transport seams', () => {
    function transportWithCapture(): { tx: StreamableHTTPClientTransport; sent: () => Headers } {
        let captured: Headers | undefined;
        const fetch = vi.fn(async (_url, init) => {
            captured = new Headers((init as RequestInit).headers);
            return new Response(null, { status: 202, headers: { 'content-type': 'application/json' } });
        });
        const tx = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), { fetch: fetch as typeof globalThis.fetch });
        return { tx, sent: () => captured! };
    }

    const modernRequest = (method: string, params: Record<string, unknown>): JSONRPCMessage => ({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN } }
    });

    it('Mcp-Name is sentinel-encoded for non-ASCII / unsafe values (no Headers.set TypeError)', async () => {
        const { tx, sent } = transportWithCapture();
        await tx.start();
        await tx.send(modernRequest('resources/read', { uri: 'file:///レポート.md' }));
        expect(sent().get('mcp-name')).toBe(encodeMcpParamValue('file:///レポート.md'));
        // ASCII-safe values pass through unchanged.
        await tx.send(modernRequest('tools/call', { name: 'route', arguments: {} }));
        expect(sent().get('mcp-name')).toBe('route');
    });

    it('per-request TransportSendOptions.headers cannot override reserved standard/auth headers', async () => {
        const { tx, sent } = transportWithCapture();
        await tx.start();
        await tx.send(modernRequest('tools/call', { name: 'route', arguments: {} }), {
            headers: { 'Mcp-Method': 'tools/list', authorization: 'Bearer evil', 'Mcp-Param-Region': 'us' }
        });
        expect(sent().get('mcp-method')).toBe('tools/call');
        expect(sent().get('authorization')).toBeNull();
        expect(sent().get('mcp-param-region')).toBe('us');
    });

    it('an HTTP 400 carrying a JSON-RPC error response is delivered in-band on a modern-enveloped request; legacy still throws SdkHttpError', async () => {
        const errorBody = { jsonrpc: '2.0', id: 1, error: { code: HEADER_MISMATCH_ERROR_CODE, message: 'Bad Request: …' } };
        const fetch = vi.fn(
            async () => new Response(JSON.stringify(errorBody), { status: 400, headers: { 'content-type': 'application/json' } })
        );
        const tx = new StreamableHTTPClientTransport(new URL('http://example.test/mcp'), { fetch: fetch as typeof globalThis.fetch });
        const seen: JSONRPCMessage[] = [];
        tx.onmessage = m => seen.push(m);
        await tx.start();
        await expect(tx.send(modernRequest('tools/call', { name: 'route', arguments: {} }))).resolves.toBeUndefined();
        expect(seen[0]).toMatchObject({ id: 1, error: { code: HEADER_MISMATCH_ERROR_CODE } });

        // Legacy-era exchange (no envelope claim) still surfaces 400 as the
        // generic SdkHttpError — gating keeps the "legacy paths unchanged"
        // claim true.
        await expect(tx.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'route' } })).rejects.toMatchObject({
            status: 400
        });
    });
});
