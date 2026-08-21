import {
    type AuthInfo,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    type JSONRPCRequest,
    PROTOCOL_VERSION_META_KEY,
    type StandardSchemaWithJSON
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { fromJsonSchema } from '../../src/fromJsonSchema';
import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';
import type { ToolScopePolicy } from '../../src/server/scopeChallenge';

const MODERN = '2026-07-28';
const RESOURCE_METADATA_URL = 'https://auth.example.com/.well-known/oauth-protected-resource';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'scope-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function request(method: string, params: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Request {
    const name = typeof params.name === 'string' ? params.name : undefined;
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN,
            'mcp-method': method,
            ...(name !== undefined && { 'mcp-name': name }),
            ...extraHeaders
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: ENVELOPE } })
    });
}

function call(name: string, args: Record<string, unknown>, headers?: Record<string, string>): Request {
    return request('tools/call', { name, arguments: args }, headers);
}

function auth(scopes: string[]): AuthInfo {
    return { token: 'token', clientId: 'client', scopes };
}

describe('createMcpHandler scope preflight', () => {
    it('selects a request-aware path from the full parsed request without mirroring arguments in headers', async () => {
        const selector = vi.fn((message: JSONRPCRequest): readonly string[] => {
            const args = (message.params as { arguments: { mode: string } }).arguments;
            return [args.mode];
        });
        const policy: ToolScopePolicy = {
            anyOf: [
                { name: 'read', allOf: [{ challenge: 'repo:read', anyOf: ['repo'] }] },
                { name: 'write', allOf: [{ challenge: 'repo:write', anyOf: ['repo'] }] }
            ],
            select: selector
        };
        let calls = 0;
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool(
                    'operate',
                    { inputSchema: z.object({ mode: z.string(), secret: z.string() }), scopes: policy },
                    async () => {
                        calls += 1;
                        return { content: [{ type: 'text', text: 'ok' }] };
                    }
                );
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const incoming = call('operate', { mode: 'write', secret: 'high-cardinality-value' });
        expect([...incoming.headers.keys()]).not.toContain('mcp-param-secret');
        const response = await handler.fetch(incoming, { authInfo: auth(['repo:read']) });

        expect(response.status).toBe(403);
        expect(response.headers.get('WWW-Authenticate')).toContain('scope="repo:write"');
        expect(selector).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'tools/call',
                params: expect.objectContaining({
                    arguments: { mode: 'write', secret: 'high-cardinality-value' }
                })
            })
        );
        expect(calls).toBe(0);
    });

    it('runs scope selection after Mcp-Param header/body parity', async () => {
        const selector = vi.fn(() => ['route']);
        const routeSchema = fromJsonSchema<{ region: string }>({
            type: 'object',
            properties: { region: { type: 'string', 'x-mcp-header': 'Region' } as Record<string, unknown> },
            required: ['region']
        });
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool(
                    'route',
                    {
                        inputSchema: routeSchema,
                        scopes: {
                            anyOf: [
                                {
                                    name: 'route',
                                    allOf: [{ challenge: 'route:read', anyOf: [] }]
                                }
                            ],
                            select: selector
                        }
                    },
                    async () => ({ content: [{ type: 'text', text: 'ok' }] })
                );
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const response = await handler.fetch(call('route', { region: 'us-west1' }, { 'Mcp-Param-Region': 'eu' }), {
            authInfo: auth([])
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32_020);
        expect(selector).not.toHaveBeenCalled();
    });

    it('keeps scoped tools discoverable', async () => {
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool('scoped', { scopes: ['repo:read'] }, async () => ({ content: [] }));
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const response = await handler.fetch(request('tools/list', {}), { authInfo: auth([]) });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
        expect(body.result.tools.map(tool => tool.name)).toContain('scoped');
    });

    it('distinguishes absent authentication from an authenticated token with zero scopes', async () => {
        let calls = 0;
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool('scoped', { scopes: ['repo:read'] }, async () => {
                    calls += 1;
                    return { content: [] };
                });
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        expect((await handler.fetch(call('scoped', {}))).status).toBe(200);
        expect((await handler.fetch(call('scoped', {}), { authInfo: auth([]) })).status).toBe(403);
        expect(calls).toBe(1);
    });

    it('defers malformed arguments when the selector returns undefined', async () => {
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool(
                    'scoped',
                    {
                        inputSchema: z.object({ mode: z.string() }),
                        scopes: {
                            anyOf: [{ name: 'read', allOf: [{ challenge: 'repo:read', anyOf: [] }] }],
                            select: message => {
                                const mode = (message.params as { arguments?: { mode?: unknown } }).arguments?.mode;
                                return typeof mode === 'string' ? ['read'] : undefined;
                            }
                        }
                    },
                    async () => ({ content: [] })
                );
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const response = await handler.fetch(call('scoped', { mode: 42 }), { authInfo: auth([]) });
        expect(response.status).toBe(200);
        expect(((await response.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
    });

    it('fails closed on malformed selected path names before invoke or SSE', async () => {
        const onerror = vi.fn();
        let calls = 0;
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool(
                    'scoped',
                    {
                        scopes: {
                            anyOf: [{ name: 'read', allOf: [{ challenge: 'repo:read', anyOf: [] }] }],
                            select: () => ['missing']
                        }
                    },
                    async () => {
                        calls += 1;
                        return { content: [] };
                    }
                );
                return server;
            },
            {
                onerror,
                responseMode: 'sse',
                scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
            }
        );

        const response = await handler.fetch(call('scoped', {}), { authInfo: auth([]) });
        expect(response.status).toBe(500);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(calls).toBe(0);
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('unknown path') }));
    });

    it('enforces scope policy when input-schema JSON conversion is unavailable', async () => {
        let calls = 0;
        const validateOnlySchema = {
            '~standard': {
                version: 1,
                vendor: 'validate-only',
                validate: (value: unknown) => ({ value })
            }
        } as unknown as StandardSchemaWithJSON;
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool('scoped', { inputSchema: validateOnlySchema, scopes: ['repo:read'] }, async () => {
                    calls += 1;
                    return { content: [] };
                });
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const response = await handler.fetch(call('scoped', {}), { authInfo: auth([]) });
        expect(response.status).toBe(403);
        expect(calls).toBe(0);
    });
});
