/**
 * legacyStatelessFallback — the canonical `legacy` slot value, tested
 * independently of createMcpHandler: per-request stateless serving via the
 * frozen idiom (fresh instance + sessionIdGenerator: undefined + handleRequest).
 */
import { describe, expect, it, vi } from 'vitest';
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

    it('tears the per-request pair down after a normally-completed SSE exchange (factory product close hooks fire)', async () => {
        let productClosed = false;
        const handler = legacyStatelessFallback(() => {
            const mcpServer = new McpServer({ name: 'fallback-teardown', version: '1.0.0' });
            mcpServer.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
                content: [{ type: 'text', text }]
            }));
            mcpServer.server.onclose = () => {
                productClosed = true;
            };
            return mcpServer;
        });

        const response = await handler(
            postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: 'all done' } } })
        );
        expect(response.status).toBe(200);
        // Request-bearing POSTs are answered over SSE by the stateless idiom's
        // default transport options — the dominant legacy exchange shape.
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(productClosed).toBe(false);

        // Drain the stream to completion: only then is the exchange over.
        expect(await response.text()).toContain('all done');
        await vi.waitFor(() => {
            expect(productClosed).toBe(true);
        });
    });

    it('still tears the per-request pair down when the client aborts a streaming exchange', async () => {
        let productClosed = false;
        const handler = legacyStatelessFallback(ctx => {
            const mcpServer = new McpServer({ name: 'fallback-abort', version: '1.0.0' });
            mcpServer.registerTool('park', { inputSchema: z.object({}) }, async (_args, toolCtx) => {
                await new Promise<void>(resolve => {
                    toolCtx.mcpReq.signal.addEventListener('abort', () => resolve(), { once: true });
                });
                return { content: [{ type: 'text', text: `parked on ${ctx.era}` }] };
            });
            mcpServer.server.onclose = () => {
                productClosed = true;
            };
            return mcpServer;
        });

        const controller = new AbortController();
        const request = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'park', arguments: {} } }),
            signal: controller.signal
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(productClosed).toBe(false);

        controller.abort();
        await vi.waitFor(() => {
            expect(productClosed).toBe(true);
        });
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

    it('reports failures through the optional onerror callback while keeping the 500 response', async () => {
        const onerror = vi.fn();
        const handler = legacyStatelessFallback(() => {
            throw new Error('factory exploded');
        }, onerror);

        const response = await handler(postRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
        expect(response.status).toBe(500);
        expect(((await response.json()) as JSONRPCErrorBody).error.code).toBe(-32_603);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'factory exploded' }));
    });
});
