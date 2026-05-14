import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike } from '@modelcontextprotocol/core';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { handleStatelessHttp, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

/** Returns a `fetch` that routes every request through the given in-process handler. */
function fetchVia(handler: (req: Request) => Promise<Response>): FetchLike {
    return async (input, init) => handler(new Request(input, init));
}

function makeServer() {
    const mcp = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    mcp.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
    return mcp;
}

const URL_ = new URL('http://test.local/mcp');

const META = {
    full: {
        'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {}
    }
};

function rawPost(body: unknown, headers?: Record<string, string>) {
    return new Request(URL_, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            ...headers
        },
        body: JSON.stringify(body)
    });
}

describe('handleStatelessHttp', () => {
    describe('serving stateless clients end-to-end', () => {
        it('negotiates via server/discover and routes to handleStatelessRequest', async () => {
            const handler = handleStatelessHttp(makeServer);
            const client = new Client({ name: 'c', version: '1' }, { negotiationMode: 'stateless' });
            const transport = new StreamableHTTPClientTransport(URL_, { fetch: fetchVia(handler) });
            await client.connect(transport);

            expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            expect(client.getServerCapabilities()?.tools).toBeDefined();
            // Stateless: no session id minted.
            expect(transport.sessionId).toBeUndefined();

            const tools = await client.listTools();
            expect(tools.tools.map(t => t.name)).toContain('echo');

            const result = await client.callTool({ name: 'echo', arguments: { text: 'stateless' } });
            expect(result.content).toEqual([{ type: 'text', text: 'stateless' }]);
            await client.close();
        });

        it('[R-2567-1] per-request createMcpServer(): each request gets a fresh instance', async () => {
            let instances = 0;
            const handler = handleStatelessHttp(() => {
                instances++;
                return makeServer();
            });
            const client = new Client({ name: 'c', version: '1' }, { negotiationMode: 'stateless' });
            await client.connect(new StreamableHTTPClientTransport(URL_, { fetch: fetchVia(handler) }));
            // discover (1), listTools (2), callTool (3)
            await client.listTools();
            await client.callTool({ name: 'echo', arguments: { text: 'x' } });
            expect(instances).toBe(3);
            await client.close();
        });
    });

    describe('protocol version validation', () => {
        it('[R-2575-1] rejects POST missing _meta.protocolVersion with 400/-32602', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(rawPost({ jsonrpc: '2.0', id: 7, method: 'server/discover', params: {} }));
            expect(res.status).toBe(400);
            const body = (await res.json()) as { id: number; error: { code: number; message: string } };
            expect(body.id).toBe(7);
            expect(body.error.code).toBe(-32_602);
            expect(body.error.message).toContain('protocolVersion');
        });

        it('[R-2575-4] rejects when MCP-Protocol-Version header is absent', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(
                new Request(URL_, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'server/discover', params: { _meta: META.full } })
                })
            );
            expect(res.status).toBe(400);
            const body = (await res.json()) as { id: number; error: { code: number; message: string } };
            expect(body.id).toBe(9);
            expect(body.error.code).toBe(-32_602);
            expect(body.error.message).toContain('MCP-Protocol-Version header');
        });

        it('[R-2575-4] rejects when header and _meta.protocolVersion disagree', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(
                rawPost({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/list',
                    params: { _meta: { ...META.full, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } }
                })
            );
            expect(res.status).toBe(400);
            const body = (await res.json()) as { error: { code: number; message: string } };
            expect(body.error.code).toBe(-32_602);
            expect(body.error.message).toContain('must match');
        });

        it('[R-2575-9] returns UnsupportedProtocolVersion data.{supported,requested} for a stateful-model version', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(
                rawPost(
                    {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'tools/list',
                        params: { _meta: { ...META.full, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } }
                    },
                    { 'mcp-protocol-version': '2025-11-25' }
                )
            );
            expect(res.status).toBe(400);
            const body = (await res.json()) as { error: { code: number; data: { supported: string[]; requested: string } } };
            expect(body.error.code).toBe(-32_602);
            expect(body.error.data.requested).toBe('2025-11-25');
            // data.supported matches server/discover's supportedVersions.
            expect(body.error.data.supported).toContain(LATEST_PROTOCOL_VERSION);
        });
    });

    describe('required _meta fields', () => {
        it('[R-2575-15] rejects when clientInfo is missing', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(
                rawPost({
                    jsonrpc: '2.0',
                    id: 8,
                    method: 'server/discover',
                    params: {
                        _meta: {
                            'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION,
                            'io.modelcontextprotocol/clientCapabilities': {}
                        }
                    }
                })
            );
            expect(res.status).toBe(400);
            const body = (await res.json()) as { error: { code: number; message: string } };
            expect(body.error.code).toBe(-32_602);
            expect(body.error.message).toContain('clientInfo');
        });
    });

    describe('error-code to HTTP-status mapping', () => {
        it('[R-2575-removed] -32601 MethodNotFound maps to HTTP 404', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(rawPost({ jsonrpc: '2.0', id: 3, method: 'no/such/method', params: { _meta: META.full } }));
            expect(res.status).toBe(404);
            const body = (await res.json()) as { error: { code: number } };
            expect(body.error.code).toBe(-32_601);
        });

        it('[R-2575-33] notification-only POST returns 202', async () => {
            const handler = handleStatelessHttp(makeServer);
            const res = await handler(
                rawPost({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: META.full, requestId: 1 } })
            );
            expect(res.status).toBe(202);
        });
    });

    describe('HTTP verbs', () => {
        it('[R-2567-4] returns 405 for GET/DELETE (no legacy session verbs)', async () => {
            const handler = handleStatelessHttp(makeServer);
            for (const method of ['GET', 'DELETE'] as const) {
                const res = await handler(new Request(URL_, { method }));
                expect(res.status).toBe(405);
                expect(res.headers.get('allow')).toBe('POST');
            }
        });
    });

    describe('Host-header validation', () => {
        it('rejects disallowed Host with 403', async () => {
            const handler = handleStatelessHttp(makeServer, { allowedHosts: ['allowed.example'] });
            const res = await handler(
                rawPost({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META.full } }, { host: 'evil.example' })
            );
            expect(res.status).toBe(403);
        });
        it('passes when Host matches allowlist', async () => {
            const handler = handleStatelessHttp(makeServer, { allowedHosts: ['test.local'] });
            const res = await handler(
                rawPost({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: META.full } }, { host: 'test.local' })
            );
            expect(res.status).toBe(200);
        });
    });
});
