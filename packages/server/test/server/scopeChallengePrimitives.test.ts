import { randomUUID } from 'node:crypto';

import type { AuthInfo, JSONRPCMessage } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import { McpServer, ResourceTemplate } from '../../src/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';

const RESOURCE_METADATA_URL = 'https://auth.example.com/.well-known/oauth-protected-resource';

function createRequest(body: JSONRPCMessage | JSONRPCMessage[], sessionId?: string): Request {
    const headers: Record<string, string> = {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json'
    };
    if (sessionId) {
        headers['mcp-session-id'] = sessionId;
        headers['mcp-protocol-version'] = '2025-11-25';
    }
    return new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

const INITIALIZE_MESSAGE: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
        clientInfo: { name: 'test-client', version: '1.0' },
        protocolVersion: '2025-11-25',
        capabilities: {}
    },
    id: 'init-1'
} as JSONRPCMessage;

function readResourceMessage(uri: string, id: string | number = 'read-1'): JSONRPCMessage {
    return {
        jsonrpc: '2.0',
        method: 'resources/read',
        params: { uri },
        id
    } as JSONRPCMessage;
}

function getPromptMessage(name: string, id: string | number = 'prompt-1'): JSONRPCMessage {
    return {
        jsonrpc: '2.0',
        method: 'prompts/get',
        params: { name, arguments: {} },
        id
    } as JSONRPCMessage;
}

function completionMessage(
    ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string },
    argumentName: string,
    value: string,
    id: string | number = 'comp-1'
): JSONRPCMessage {
    return {
        jsonrpc: '2.0',
        method: 'completion/complete',
        params: { ref, argument: { name: argumentName, value } },
        id
    } as JSONRPCMessage;
}

describe('Scope Challenge / non-tool primitives', () => {
    let transport: WebStandardStreamableHTTPServerTransport;
    let mcpServer: McpServer;

    afterEach(async () => {
        await transport.close();
    });

    async function initialize(): Promise<string> {
        const response = await transport.handleRequest(createRequest(INITIALIZE_MESSAGE));
        expect(response.status).toBe(200);
        return response.headers.get('mcp-session-id') as string;
    }

    function newServer(): void {
        mcpServer = new McpServer({ name: 'scope-primitives-test', version: '1.0.0' }, { capabilities: { logging: {} } });
        transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
        });
    }

    describe('resources/read', () => {
        it('returns 403 when token lacks scopes for a static resource', async () => {
            newServer();
            mcpServer.registerResource('config', 'config://settings', { scopes: ['config:read'], mimeType: 'text/plain' }, async uri => ({
                contents: [{ uri: uri.href, text: 'data' }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            const response = await transport.handleRequest(createRequest(readResourceMessage('config://settings'), sessionId), {
                authInfo
            });

            expect(response.status).toBe(403);
            const wwwAuth = response.headers.get('WWW-Authenticate')!;
            expect(wwwAuth).toContain('error="insufficient_scope"');
            expect(wwwAuth).toContain('scope="config:read"');
        });

        it('passes when token has required scope for a static resource', async () => {
            newServer();
            mcpServer.registerResource('config', 'config://settings', { scopes: ['config:read'], mimeType: 'text/plain' }, async uri => ({
                contents: [{ uri: uri.href, text: 'data' }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: ['config:read'] };

            const response = await transport.handleRequest(createRequest(readResourceMessage('config://settings'), sessionId), {
                authInfo
            });
            expect(response.status).toBe(200);
        });

        it('passes through static resources with no scope configuration', async () => {
            newServer();
            mcpServer.registerResource('public', 'public://thing', { mimeType: 'text/plain' }, async uri => ({
                contents: [{ uri: uri.href, text: 'data' }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            const response = await transport.handleRequest(createRequest(readResourceMessage('public://thing'), sessionId), {
                authInfo
            });
            expect(response.status).toBe(200);
        });

        it('matches a templated URI and returns 403 when scopes are missing', async () => {
            newServer();
            mcpServer.registerResource(
                'repo',
                new ResourceTemplate('github://{owner}/{repo}', { list: undefined }),
                { scopes: ['repo:read'] },
                async (uri, variables) => ({ contents: [{ uri: uri.href, text: JSON.stringify(variables) }] })
            );
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            const response = await transport.handleRequest(createRequest(readResourceMessage('github://octo/hello'), sessionId), {
                authInfo
            });
            expect(response.status).toBe(403);
            expect(response.headers.get('WWW-Authenticate')).toContain('scope="repo:read"');
        });

        it('resolves dynamic per-request scopes from template variables', async () => {
            newServer();
            mcpServer.registerResource(
                'repo',
                new ResourceTemplate('github://{owner}/{repo}', { list: undefined }),
                {
                    scopes: (_uri, variables) => (variables.owner === 'private-org' ? ['repo'] : ['public_repo'])
                },
                async (uri, variables) => ({ contents: [{ uri: uri.href, text: JSON.stringify(variables) }] })
            );
            await mcpServer.connect(transport);
            const sessionId = await initialize();

            // private-org token only has public_repo -> 403 with `repo` advertised
            const privateResponse = await transport.handleRequest(
                createRequest(readResourceMessage('github://private-org/secret'), sessionId),
                { authInfo: { token: 't', clientId: 'c', scopes: ['public_repo'] } }
            );
            expect(privateResponse.status).toBe(403);
            expect(privateResponse.headers.get('WWW-Authenticate')).toContain('scope="repo"');

            // public org with public_repo token -> 200
            const publicResponse = await transport.handleRequest(createRequest(readResourceMessage('github://octo/hello'), sessionId), {
                authInfo: { token: 't', clientId: 'c', scopes: ['public_repo'] }
            });
            expect(publicResponse.status).toBe(200);
        });
    });

    describe('prompts/get', () => {
        it('returns 403 when token lacks the prompt scope', async () => {
            newServer();
            mcpServer.registerPrompt('summarise_repo', { description: 'Summarise a repo', scopes: ['repo:read'] }, () => ({
                messages: [{ role: 'user', content: { type: 'text', text: 'go' } }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            const response = await transport.handleRequest(createRequest(getPromptMessage('summarise_repo'), sessionId), {
                authInfo
            });
            expect(response.status).toBe(403);
            expect(response.headers.get('WWW-Authenticate')).toContain('scope="repo:read"');
        });

        it('passes when token has the prompt scope', async () => {
            newServer();
            mcpServer.registerPrompt('summarise_repo', { description: 'Summarise a repo', scopes: ['repo:read'] }, () => ({
                messages: [{ role: 'user', content: { type: 'text', text: 'go' } }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: ['repo:read'] };

            const response = await transport.handleRequest(createRequest(getPromptMessage('summarise_repo'), sessionId), {
                authInfo
            });
            expect(response.status).toBe(200);
        });

        it('passes through prompts with no scope configuration', async () => {
            newServer();
            mcpServer.registerPrompt('hello', { description: 'Hello' }, () => ({
                messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            const response = await transport.handleRequest(createRequest(getPromptMessage('hello'), sessionId), { authInfo });
            expect(response.status).toBe(200);
        });
    });

    describe('completion/complete (explicit, no inheritance)', () => {
        it('returns 403 when completion scope is missing for the specific argument', async () => {
            newServer();
            mcpServer.registerPrompt(
                'summarise_repo',
                { description: 'Summarise a repo', argsSchema: z.object({ repository: z.string() }) },
                () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'x' } }] })
            );
            mcpServer.setCompletionScopes({ type: 'ref/prompt', name: 'summarise_repo' }, 'repository', ['repo:list']);
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: ['repo:read'] };

            const response = await transport.handleRequest(
                createRequest(completionMessage({ type: 'ref/prompt', name: 'summarise_repo' }, 'repository', 'oc'), sessionId),
                { authInfo }
            );
            expect(response.status).toBe(403);
            expect(response.headers.get('WWW-Authenticate')).toContain('scope="repo:list"');
        });

        it('does not inherit scopes from the referenced prompt', async () => {
            // A prompt requires repo:read; completion has no scopes configured.
            // Token has nothing. The completion should still pass through because
            // completion scopes are explicit-only (no inheritance).
            newServer();
            mcpServer.registerPrompt(
                'summarise_repo',
                {
                    description: 'Summarise a repo',
                    scopes: ['repo:read'],
                    argsSchema: z.object({ repository: z.string() })
                },
                () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'x' } }] })
            );
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            const response = await transport.handleRequest(
                createRequest(completionMessage({ type: 'ref/prompt', name: 'summarise_repo' }, 'repository', 'oc'), sessionId),
                { authInfo }
            );
            expect(response.status).toBe(200);
        });

        it('applies the * wildcard to any argument of the same ref', async () => {
            newServer();
            mcpServer.registerPrompt(
                'summarise_repo',
                { description: 'x', argsSchema: z.object({ a: z.string(), b: z.string() }) },
                () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'x' } }] })
            );
            mcpServer.setCompletionScopes({ type: 'ref/prompt', name: 'summarise_repo' }, '*', ['repo:list']);
            await mcpServer.connect(transport);
            const sessionId = await initialize();
            const authInfo: AuthInfo = { token: 't', clientId: 'c', scopes: [] };

            for (const argName of ['a', 'b']) {
                const response = await transport.handleRequest(
                    createRequest(completionMessage({ type: 'ref/prompt', name: 'summarise_repo' }, argName, 'x'), sessionId),
                    { authInfo }
                );
                expect(response.status).toBe(403);
            }
        });
    });

    describe('setResourceScopes / setPromptScopes overrides', () => {
        it('setResourceScopes for a static URI overrides registration-time scopes', async () => {
            newServer();
            mcpServer.registerResource('config', 'config://settings', { scopes: ['config:read'] }, async uri => ({
                contents: [{ uri: uri.href, text: 'data' }]
            }));
            mcpServer.setResourceScopes('config://settings', ['admin:config']);
            await mcpServer.connect(transport);
            const sessionId = await initialize();

            const response = await transport.handleRequest(createRequest(readResourceMessage('config://settings'), sessionId), {
                authInfo: { token: 't', clientId: 'c', scopes: ['config:read'] }
            });
            expect(response.status).toBe(403);
            expect(response.headers.get('WWW-Authenticate')).toContain('scope="admin:config"');
        });

        it('setPromptScopes overrides registration-time scopes', async () => {
            newServer();
            mcpServer.registerPrompt('summarise_repo', { description: 'x', scopes: ['repo:read'] }, () => ({
                messages: [{ role: 'user', content: { type: 'text', text: 'x' } }]
            }));
            mcpServer.setPromptScopes('summarise_repo', ['admin:repo']);
            await mcpServer.connect(transport);
            const sessionId = await initialize();

            const response = await transport.handleRequest(createRequest(getPromptMessage('summarise_repo'), sessionId), {
                authInfo: { token: 't', clientId: 'c', scopes: ['repo:read'] }
            });
            expect(response.status).toBe(403);
            expect(response.headers.get('WWW-Authenticate')).toContain('scope="admin:repo"');
        });
    });

    describe('mixed batch', () => {
        it('returns 403 when any request in a mixed batch lacks scopes', async () => {
            newServer();
            mcpServer.registerPrompt('p', { description: 'x', scopes: ['p:read'] }, () => ({
                messages: [{ role: 'user', content: { type: 'text', text: 'x' } }]
            }));
            mcpServer.registerResource('config', 'config://settings', { scopes: ['config:read'] }, async uri => ({
                contents: [{ uri: uri.href, text: 'data' }]
            }));
            await mcpServer.connect(transport);
            const sessionId = await initialize();

            const batch: JSONRPCMessage[] = [getPromptMessage('p', 'b1'), readResourceMessage('config://settings', 'b2')];
            // Token has p:read but missing config:read - resource read should fail.
            const response = await transport.handleRequest(createRequest(batch, sessionId), {
                authInfo: { token: 't', clientId: 'c', scopes: ['p:read'] }
            });
            expect(response.status).toBe(403);
            expect(response.headers.get('WWW-Authenticate')).toContain('scope="config:read"');
        });
    });
});
