import type { AuthInfo, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { fromJsonSchema } from '../../src/fromJsonSchema';
import { createMcpHandler } from '../../src/server/createMcpHandler';
import { McpServer } from '../../src/server/mcp';
import type { ScopeChallengeHandler } from '../../src/server/scopeChallenge';
import { requireScopes } from '../../src/server/scopeChallenge';

const MODERN = '2026-07-28';
const RESOURCE_METADATA_URL = 'https://auth.example.com/.well-known/oauth-protected-resource';
const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'scope-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

function request(method: string, params: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Request {
    const candidateName = method === 'resources/read' ? params.uri : params.name;
    const name = typeof candidateName === 'string' ? candidateName : undefined;
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

function createHandler(scopeChallenge: ScopeChallengeHandler, onCall = vi.fn(), responseMode?: 'json' | 'sse') {
    return createMcpHandler(
        () => {
            const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
            server.registerTool(
                'operate',
                {
                    inputSchema: z.object({ mode: z.string().optional(), secret: z.string().optional() }),
                    scopeChallenge
                },
                async args => {
                    onCall(args);
                    return { content: [{ type: 'text', text: 'ok' }] };
                }
            );
            return server;
        },
        {
            ...(responseMode !== undefined && { responseMode }),
            scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
        }
    );
}

describe('createMcpHandler scope preflight', () => {
    it('passes the full parsed request and auth info to an async callback before invocation', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(async ({ request, authInfo }) => {
            const args = (request.params as { arguments: { mode?: string } }).arguments;
            return args.mode === 'write' && !authInfo?.scopes.includes('repo:write') ? { scopes: ['repo:write'] } : undefined;
        });
        const onCall = vi.fn();
        const handler = createHandler(callback, onCall);
        const incoming = call('operate', { mode: 'write', secret: 'high-cardinality-value' });

        expect([...incoming.headers.keys()]).not.toContain('mcp-param-secret');
        const response = await handler.fetch(incoming, { authInfo: auth(['repo:read']) });

        expect(response.status).toBe(403);
        expect(response.headers.get('WWW-Authenticate')).toContain('scope="repo:write"');
        expect(response.headers.get('WWW-Authenticate')).not.toContain('error_description');
        expect(callback).toHaveBeenCalledWith({
            request: expect.objectContaining({
                method: 'tools/call',
                params: expect.objectContaining({
                    arguments: { mode: 'write', secret: 'high-cardinality-value' }
                })
            }),
            authInfo: auth(['repo:read'])
        });
        expect(onCall).not.toHaveBeenCalled();
    });

    it('runs the callback after Mcp-Param header/body parity checks', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(() => ({ scopes: ['route:read'] }));
        const routeSchema = fromJsonSchema<{ region: string }>({
            type: 'object',
            properties: { region: { type: 'string', 'x-mcp-header': 'Region' } as Record<string, unknown> },
            required: ['region']
        });
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool('route', { inputSchema: routeSchema, scopeChallenge: callback }, async () => ({
                    content: [{ type: 'text', text: 'ok' }]
                }));
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const response = await handler.fetch(call('route', { region: 'us-west1' }, { 'Mcp-Param-Region': 'eu' }), {
            authInfo: auth([])
        });

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32_020);
        expect(callback).not.toHaveBeenCalled();
    });

    it('keeps challenged tools discoverable and uses exact static all-of checks', async () => {
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerTool('scoped', { scopeChallenge: requireScopes('repo:read', 'org:read') }, async () => ({
                    content: []
                }));
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const listResponse = await handler.fetch(request('tools/list', {}), { authInfo: auth([]) });
        expect(listResponse.status).toBe(200);
        const body = (await listResponse.json()) as { result: { tools: Array<{ name: string }> } };
        expect(body.result.tools.map(tool => tool.name)).toContain('scoped');

        const challengeResponse = await handler.fetch(call('scoped', {}), { authInfo: auth(['repo:read']) });
        expect(challengeResponse.status).toBe(403);
        expect(challengeResponse.headers.get('WWW-Authenticate')).toContain('scope="repo:read org:read"');
    });

    it('fails closed before SSE when the callback throws', async () => {
        const onCall = vi.fn();
        const handler = createHandler(
            async () => {
                throw new Error('scope lookup failed');
            },
            onCall,
            'sse'
        );

        const response = await handler.fetch(call('operate', {}), { authInfo: auth([]) });

        expect(response.status).toBe(500);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(onCall).not.toHaveBeenCalled();
    });

    it('continues when the callback returns undefined', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(({ request }: { request: JSONRPCRequest }) => {
            const mode = (request.params as { arguments?: { mode?: unknown } }).arguments?.mode;
            return mode === 'write' ? { scopes: ['repo:write'] } : undefined;
        });
        const onCall = vi.fn();
        const handler = createHandler(callback, onCall);

        const response = await handler.fetch(call('operate', { mode: 'read' }), { authInfo: auth([]) });

        expect(response.status).toBe(200);
        expect(onCall).toHaveBeenCalledOnce();
    });

    it('challenges resource and prompt primitives before dispatch', async () => {
        const onRead = vi.fn(async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'secret' }] }));
        const onPrompt = vi.fn(async () => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'secret' } }]
        }));
        const handler = createMcpHandler(
            () => {
                const server = new McpServer({ name: 'modern-scope', version: '1.0.0' });
                server.registerResource('config', 'config://settings', { scopeChallenge: requireScopes('config:read') }, onRead);
                server.registerPrompt('summarize', { scopeChallenge: requireScopes('prompt:read') }, onPrompt);
                return server;
            },
            { scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL } }
        );

        const resourceResponse = await handler.fetch(request('resources/read', { uri: 'config://settings' }), {
            authInfo: auth([])
        });
        const promptResponse = await handler.fetch(request('prompts/get', { name: 'summarize', arguments: {} }), {
            authInfo: auth([])
        });

        expect(resourceResponse.status).toBe(403);
        expect(resourceResponse.headers.get('WWW-Authenticate')).toContain('scope="config:read"');
        expect(promptResponse.status).toBe(403);
        expect(promptResponse.headers.get('WWW-Authenticate')).toContain('scope="prompt:read"');
        expect(onRead).not.toHaveBeenCalled();
        expect(onPrompt).not.toHaveBeenCalled();
    });
});
