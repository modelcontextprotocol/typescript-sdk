/**
 * SEP-2243 server-side `Mcp-Param-*` validation at the createMcpHandler entry
 * (protocol revision 2026-07-28).
 *
 * Pre-dispatch ladder rung: a `tools/call` whose `Mcp-Param-{Name}` headers
 * disagree with the body `arguments` (or are missing for a present body value,
 * or carry an invalid Base64 sentinel) is rejected `400` / `-32020` with the
 * same `HeaderMismatch` shape the inbound classifier emits for the
 * standard-header cross-checks. A `null`/absent body value passes regardless
 * of the header (the spec's "server MUST NOT expect" rows). The
 * registration-time declaration-validity check warns on invalid declarations.
 */
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    encodeMcpParamValue,
    PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import { fromJsonSchema } from '../../src/fromJsonSchema.js';
import { createMcpHandler } from '../../src/server/createMcpHandler.js';
import { McpServer } from '../../src/server/mcp.js';

const MODERN = '2026-07-28';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'param-test', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const REGION_INPUT_SCHEMA = {
    type: 'object',
    properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } }
} as const;

function makeFactory(): () => McpServer {
    return () => {
        const s = new McpServer({ name: 'param-server', version: '1.0.0' });
        s.registerTool('route', { inputSchema: fromJsonSchema<{ region?: string; query?: string }>(REGION_INPUT_SCHEMA) }, async args => ({
            content: [{ type: 'text', text: `routed ${args.region ?? '<none>'}` }]
        }));
        return s;
    };
}

function call(args: Record<string, unknown>, paramHeaders: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN,
            'mcp-method': 'tools/call',
            'mcp-name': 'route',
            ...paramHeaders
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'route', arguments: args, _meta: ENVELOPE }
        })
    });
}

describe('SEP-2243 Mcp-Param-* server validation (createMcpHandler, modern era)', () => {
    it('a matching Mcp-Param header passes and the call dispatches', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(call({ region: 'us-west1', query: 'x' }, { 'Mcp-Param-Region': 'us-west1' }));
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('routed us-west1');
    });

    it('a Base64-sentinel header decodes and matches', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(call({ region: 'Hello, 世界' }, { 'Mcp-Param-Region': encodeMcpParamValue('Hello, 世界') }));
        expect(response.status).toBe(200);
    });

    it('a disagreeing header is rejected 400/-32020 (HeaderMismatch) and reports the rejection', async () => {
        const onerror = vi.fn();
        const handler = createMcpHandler(makeFactory(), { onerror });
        const response = await handler.fetch(call({ region: 'us-west1' }, { 'Mcp-Param-Region': 'eu' }));
        expect(response.status).toBe(400);
        const body = (await response.json()) as { id: unknown; error: { code: number; data?: { mismatch?: { header?: string } } } };
        expect(body.error.code).toBe(-32_020);
        expect(body.error.data?.mismatch?.header).toBe('Mcp-Param-Region');
        expect(body.id).toBe(7);
        expect(onerror).toHaveBeenCalled();
    });

    // sep-2243-server-reject-missing-required (globally-untested manifest check).
    it('a missing header for a present body value is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(call({ region: 'us-west1' }));
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: number } };
        expect(body.error.code).toBe(-32_020);
    });

    // sep-2243-server-not-expect-null (globally-untested manifest check).
    it('a null/absent body value passes regardless of any stray header', async () => {
        const handler = createMcpHandler(makeFactory());
        const r1 = await handler.fetch(call({ query: 'x' }, { 'Mcp-Param-Region': 'whatever' }));
        const r2 = await handler.fetch(call({ region: null as unknown as string, query: 'x' }));
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
    });

    it('an invalid Base64 sentinel is rejected 400/-32020', async () => {
        const handler = createMcpHandler(makeFactory());
        const response = await handler.fetch(call({ region: 'Hello' }, { 'Mcp-Param-Region': '=?base64?SGVsbG8?=' }));
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32_020);
    });
});

describe('SEP-2243 registerTool declaration-validity check', () => {
    it('warns on an invalid x-mcp-header declaration at registration time', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const s = new McpServer({ name: 'warn-server', version: '1.0.0' });
        s.registerTool(
            'bad',
            {
                inputSchema: fromJsonSchema({
                    type: 'object',
                    properties: { a: { type: 'object', 'x-mcp-header': 'Data' } as Record<string, unknown> }
                })
            },
            async () => ({ content: [] })
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool 'bad' carries an invalid x-mcp-header"));
        warn.mockRestore();
    });
});
