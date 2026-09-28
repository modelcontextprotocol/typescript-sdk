import { randomUUID } from 'node:crypto';

import type { AuthInfo, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import { McpServer, ResourceTemplate } from '../../src/server/mcp';
import type { ScopeChallengeHandler } from '../../src/server/scopeChallenge';
import { requireScopes } from '../../src/server/scopeChallenge';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

function auth(scopes: string[]): AuthInfo {
    return { token: 'token', clientId: 'client', scopes };
}

function readResource(uri: string, id: string | number = 'read-1'): JSONRPCRequest {
    return { jsonrpc: '2.0', method: 'resources/read', params: { uri }, id };
}

function getPrompt(name: string, id: string | number = 'prompt-1'): JSONRPCRequest {
    return { jsonrpc: '2.0', method: 'prompts/get', params: { name, arguments: {} }, id };
}

function request(body: JSONRPCMessage | JSONRPCMessage[], sessionId?: string): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(sessionId !== undefined && {
                'mcp-session-id': sessionId,
                'mcp-protocol-version': '2025-11-25'
            })
        },
        body: JSON.stringify(body)
    });
}

async function initialize(transport: WebStandardStreamableHTTPServerTransport): Promise<string> {
    const response = await transport.handleRequest(
        request({
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                protocolVersion: '2025-11-25',
                capabilities: {}
            },
            id: 'init'
        })
    );
    return response.headers.get('mcp-session-id')!;
}

async function createHarness(server: McpServer): Promise<{
    transport: WebStandardStreamableHTTPServerTransport;
    sessionId: string;
}> {
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true
    });
    await server.connect(transport);
    return { transport, sessionId: await initialize(transport) };
}

describe('scope challenges for resources and prompts', () => {
    it('challenges static resources and prompts before their handlers run', async () => {
        const server = new McpServer({ name: 'scope-primitives', version: '1.0.0' });
        const read = vi.fn(async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'secret' }] }));
        const render = vi.fn(async () => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'secret' } }]
        }));
        server.registerResource(
            'config',
            'config://settings',
            { mimeType: 'text/plain', scopeChallenge: requireScopes('config:read') },
            read
        );
        server.registerPrompt('summarize', { scopeChallenge: requireScopes('prompt:read') }, render);
        const { transport, sessionId } = await createHarness(server);

        const resourceResponse = await transport.handleRequest(request(readResource('config://settings'), sessionId), {
            authInfo: auth([])
        });
        const promptResponse = await transport.handleRequest(request(getPrompt('summarize'), sessionId), {
            authInfo: auth([])
        });

        expect(resourceResponse.status).toBe(403);
        expect(resourceResponse.headers.get('WWW-Authenticate')).toContain('scope="config:read"');
        expect(promptResponse.status).toBe(403);
        expect(promptResponse.headers.get('WWW-Authenticate')).toContain('scope="prompt:read"');
        expect(read).not.toHaveBeenCalled();
        expect(render).not.toHaveBeenCalled();
        await transport.close();
    });

    it('routes a template resource request to its request-aware callback', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(({ request: incoming, authInfo }) => {
            const uri = (incoming.params as { uri?: unknown }).uri;
            const scopes = typeof uri === 'string' && uri.includes('/private/') ? (['repo:read'] as const) : (['public_repo'] as const);
            return scopes.every(scope => authInfo?.scopes.includes(scope)) ? undefined : { scopes };
        });
        const read = vi.fn(async (uri: URL) => ({ contents: [{ uri: uri.href, text: 'repository' }] }));
        const server = new McpServer({ name: 'scope-primitives', version: '1.0.0' });
        server.registerResource(
            'repository',
            new ResourceTemplate('github://{owner}/{visibility}/{repo}', { list: undefined }),
            { scopeChallenge: callback },
            read
        );
        const { transport, sessionId } = await createHarness(server);

        const privateResponse = await transport.handleRequest(request(readResource('github://octo/private/sdk'), sessionId), {
            authInfo: auth(['public_repo'])
        });
        const publicResponse = await transport.handleRequest(request(readResource('github://octo/public/sdk'), sessionId), {
            authInfo: auth(['public_repo'])
        });

        expect(privateResponse.status).toBe(403);
        expect(privateResponse.headers.get('WWW-Authenticate')).toContain('scope="repo:read"');
        expect(publicResponse.status).toBe(200);
        expect(callback).toHaveBeenCalledWith({
            request: expect.objectContaining({
                method: 'resources/read',
                params: { uri: 'github://octo/private/sdk' }
            }),
            authInfo: auth(['public_repo'])
        });
        expect(read).toHaveBeenCalledOnce();
        await transport.close();
    });

    it('tracks callback updates and enabled state for every primitive', async () => {
        const server = new McpServer({ name: 'scope-primitives', version: '1.0.0' });
        const resource = server.registerResource(
            'config',
            'config://settings',
            { scopeChallenge: requireScopes('config:read') },
            async uri => ({ contents: [{ uri: uri.href, text: 'config' }] })
        );
        const template = server.registerResource(
            'repository',
            new ResourceTemplate('github://{owner}/{repo}', { list: undefined }),
            { scopeChallenge: requireScopes('repo:read') },
            async uri => ({ contents: [{ uri: uri.href, text: 'repository' }] })
        );
        const prompt = server.registerPrompt('summarize', { scopeChallenge: requireScopes('prompt:read') }, async () => ({
            messages: []
        }));

        expect(await server.resolveScopeChallenge({ request: readResource('config://settings'), authInfo: auth([]) })).toEqual({
            scopes: ['config:read']
        });
        expect(await server.resolveScopeChallenge({ request: readResource('github://octo/sdk'), authInfo: auth([]) })).toEqual({
            scopes: ['repo:read']
        });
        expect(await server.resolveScopeChallenge({ request: getPrompt('summarize'), authInfo: auth([]) })).toEqual({
            scopes: ['prompt:read']
        });

        resource.update({ scopeChallenge: requireScopes('config:admin') });
        template.disable();
        prompt.update({ scopeChallenge: null });

        expect(await server.resolveScopeChallenge({ request: readResource('config://settings'), authInfo: auth([]) })).toEqual({
            scopes: ['config:admin']
        });
        expect(await server.resolveScopeChallenge({ request: readResource('github://octo/sdk'), authInfo: auth([]) })).toBeUndefined();
        expect(await server.resolveScopeChallenge({ request: getPrompt('summarize'), authInfo: auth([]) })).toBeUndefined();
    });

    it('leaves malformed and non-invocation requests to normal protocol handling', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(requireScopes('resource:read'));
        const server = new McpServer({ name: 'scope-primitives', version: '1.0.0' });
        server.registerResource('config', 'config://settings', { scopeChallenge: callback }, async uri => ({
            contents: [{ uri: uri.href, text: 'config' }]
        }));

        expect(
            await server.resolveScopeChallenge({
                request: readResource('not a valid URI'),
                authInfo: auth([])
            })
        ).toBeUndefined();
        expect(
            await server.resolveScopeChallenge({
                request: { jsonrpc: '2.0', method: 'resources/list', params: {}, id: 'list' },
                authInfo: auth([])
            })
        ).toBeUndefined();
        expect(callback).not.toHaveBeenCalled();
    });
});
