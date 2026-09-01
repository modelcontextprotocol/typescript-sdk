/**
 * The internal per-request invoke seam: one classified message in, one HTTP
 * response out — value-returning and independently testable, with no HTTP
 * server and no changes to protocol dispatch.
 *
 * The tests mark factory instances as modern-era through the package-internal
 * negotiated-version hook, standing in for the HTTP entry that will own that
 * write in production.
 */
import type { JSONRPCNotification, JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/server/mcp';
import { Server } from '../../src/server/server';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'invoke-seam-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const toolsCall = (name: string, args: Record<string, unknown>): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args, _meta: ENVELOPE }
    }) as JSONRPCRequest;

function modernMcpServer(): McpServer {
    const mcpServer = new McpServer({ name: 'invoke-seam-test', version: '1.0.0' });
    mcpServer.registerTool('greet', { inputSchema: z.object({ who: z.string() }) }, async ({ who }) => ({
        content: [{ type: 'text', text: `hello ${who}` }]
    }));
    // Stand-in for the HTTP entry, which marks factory instances as modern-era
    // at binding time through the same package-internal hook.
    setNegotiatedProtocolVersion(mcpServer.server, MODERN_REVISION);
    return mcpServer;
}

describe('invoke', () => {
    it('serves a classified request on a high-level server instance and returns the response value', async () => {
        const response = await invoke(modernMcpServer(), toolsCall('greet', { who: 'world' }), { classification: MODERN });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
        expect(body.result.content[0]?.text).toBe('hello world');
    });

    it('serves a classified request on a low-level server instance', async () => {
        const server = new Server({ name: 'low-level', version: '1.0.0' }, { capabilities: {} });
        server.setRequestHandler('app/sum', { params: z.looseObject({ a: z.number(), b: z.number() }) }, async params => ({
            sum: params.a + params.b
        }));
        setNegotiatedProtocolVersion(server, MODERN_REVISION);
        const response = await invoke(
            server,
            { jsonrpc: '2.0', id: 7, method: 'app/sum', params: { a: 2, b: 3, _meta: ENVELOPE } } as JSONRPCRequest,
            { classification: MODERN }
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as { id: number; result: { sum: number } };
        expect(body.id).toBe(7);
        expect(body.result.sum).toBe(5);
    });

    it('answers an era-removed method with method-not-found and HTTP 404', async () => {
        const response = await invoke(
            modernMcpServer(),
            { jsonrpc: '2.0', id: 2, method: 'ping', params: { _meta: ENVELOPE } } as JSONRPCRequest,
            { classification: MODERN }
        );
        expect(response.status).toBe(404);
        const body = (await response.json()) as { error: { code: number } };
        expect(body.error.code).toBe(-32_601);
    });

    it('acknowledges classified notifications with 202 and no body', async () => {
        const response = await invoke(
            modernMcpServer(),
            { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } } as JSONRPCNotification,
            { classification: MODERN }
        );
        expect(response.status).toBe(202);
        expect(await response.text()).toBe('');
    });

    it('protects unmarked instances: modern-classified traffic gets the protocol-version error', async () => {
        const mcpServer = new McpServer({ name: 'unmarked', version: '1.0.0' });
        mcpServer.registerTool('greet', { inputSchema: z.object({ who: z.string() }) }, async ({ who }) => ({
            content: [{ type: 'text', text: `hello ${who}` }]
        }));
        mcpServer.server.onerror = () => {
            // the era mismatch is also surfaced out of band; irrelevant here
        };
        const response = await invoke(mcpServer, toolsCall('greet', { who: 'world' }), { classification: MODERN });
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: { code: number; data: { supported: string[] } } };
        expect(body.error.code).toBe(-32_022);
        expect(Array.isArray(body.error.data.supported)).toBe(true);
    });

    it('passes the original request and caller-supplied auth info through to handler context', async () => {
        const mcpServer = new McpServer({ name: 'ctx-check', version: '1.0.0' });
        let seenAuthClientId: string | undefined;
        let seenAuthorizationHeader: string | null | undefined;
        mcpServer.registerTool('whoami', { inputSchema: z.object({}) }, async (_args, ctx) => {
            seenAuthClientId = ctx.http?.authInfo?.clientId;
            seenAuthorizationHeader = ctx.http?.req?.headers.get('authorization');
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        setNegotiatedProtocolVersion(mcpServer.server, MODERN_REVISION);

        const request = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer raw-header-token' }
        });
        const response = await invoke(mcpServer, toolsCall('whoami', {}), {
            classification: MODERN,
            request,
            authInfo: { token: 'verified-token', clientId: 'client-42', scopes: ['mcp'] }
        });
        expect(response.status).toBe(200);
        // Caller-supplied auth info arrives as-is; the raw header stays a raw
        // header and is never promoted to auth info by the seam.
        expect(seenAuthClientId).toBe('client-42');
        expect(seenAuthorizationHeader).toBe('Bearer raw-header-token');
    });
});
