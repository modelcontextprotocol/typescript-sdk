/**
 * legacyStatelessFallback — the canonical `legacy` slot value, tested
 * independently of createMcpHandler: per-request stateless serving via the
 * frozen idiom (fresh instance + sessionIdGenerator: undefined + handleRequest).
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { McpRequestContext } from '../../src/server/createMcpHandler.js';
import { legacyStatelessFallback } from '../../src/server/createMcpHandler.js';
import { McpServer } from '../../src/server/mcp.js';

interface JSONRPCErrorBody {
    jsonrpc: string;
    id: unknown;
    error: { code: number; message: string };
}

function postRequest(body: unknown): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
    });
}

describe('legacyStatelessFallback', () => {
    it('serves each POST on a fresh instance from the factory (stateless idiom)', async () => {
        const contexts: McpRequestContext[] = [];
        const products: McpServer[] = [];
        const handler = legacyStatelessFallback(ctx => {
            contexts.push(ctx);
            const mcpServer = new McpServer({ name: 'fallback-test', version: '1.0.0' });
            mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
                content: [{ type: 'text', text }]
            }));
            products.push(mcpServer);
            return mcpServer;
        });

        const first = await handler(
            postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'one' } } })
        );
        expect(first.status).toBe(200);
        expect(await first.text()).toContain('one');

        const second = await handler(
            postRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'two' } } })
        );
        expect(second.status).toBe(200);
        expect(await second.text()).toContain('two');

        expect(products).toHaveLength(2);
        expect(products[0]).not.toBe(products[1]);
        expect(contexts.every(ctx => ctx.era === 'legacy')).toBe(true);
    });

    it('passes caller-provided authInfo and parsedBody through to the legacy transport', async () => {
        let seenClientId: string | undefined;
        const handler = legacyStatelessFallback(() => {
            const mcpServer = new McpServer({ name: 'fallback-auth', version: '1.0.0' });
            mcpServer.registerTool('whoami', { inputSchema: z.object({}) }, async (_args, ctx) => {
                seenClientId = ctx.http?.authInfo?.clientId;
                return { content: [{ type: 'text', text: 'ok' }] };
            });
            return mcpServer;
        });

        const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };
        const response = await handler(postRequest(body), {
            authInfo: { token: 'verified', clientId: 'fallback-client', scopes: [] },
            parsedBody: body
        });
        expect(response.status).toBe(200);
        // Drain the exchange before asserting: the tool handler runs while the
        // per-request stream is open.
        expect(await response.text()).toContain('ok');
        expect(seenClientId).toBe('fallback-client');
    });

    it('answers GET and DELETE with 405 / Method not allowed. like the canonical stateless example', async () => {
        const handler = legacyStatelessFallback(() => new McpServer({ name: 'fallback-405', version: '1.0.0' }));

        for (const method of ['GET', 'DELETE']) {
            const response = await handler(new Request('http://localhost/mcp', { method }));
            expect(response.status).toBe(405);
            const body = (await response.json()) as JSONRPCErrorBody;
            expect(body.error.code).toBe(-32_000);
            expect(body.error.message).toBe('Method not allowed.');
            expect(body.id).toBeNull();
        }
    });

    it('answers factory failures with a 500 internal error body', async () => {
        const handler = legacyStatelessFallback(() => {
            throw new Error('factory exploded');
        });
        const response = await handler(postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
        expect(response.status).toBe(500);
        const body = (await response.json()) as JSONRPCErrorBody;
        expect(body.error.code).toBe(-32_603);
    });
});
