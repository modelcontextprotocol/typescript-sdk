import { randomUUID } from 'node:crypto';

import type { AuthInfo, CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';

/**
 * Helper to create a Web Standard Request
 */
function createRequest(
    method: string,
    body?: JSONRPCMessage | JSONRPCMessage[],
    options?: {
        sessionId?: string;
        accept?: string;
        contentType?: string;
        extraHeaders?: Record<string, string>;
    }
): Request {
    const headers: Record<string, string> = {};

    if (options?.accept) {
        headers['Accept'] = options.accept;
    } else if (method === 'POST') {
        headers['Accept'] = 'application/json, text/event-stream';
    } else if (method === 'GET') {
        headers['Accept'] = 'text/event-stream';
    }

    if (options?.contentType) {
        headers['Content-Type'] = options.contentType;
    } else if (body) {
        headers['Content-Type'] = 'application/json';
    }

    if (options?.sessionId) {
        headers['mcp-session-id'] = options.sessionId;
        headers['mcp-protocol-version'] = '2025-11-25';
    }

    if (options?.extraHeaders) {
        Object.assign(headers, options.extraHeaders);
    }

    return new Request('http://localhost/mcp', {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
}

const RESOURCE_METADATA_URL = 'https://auth.example.com/.well-known/oauth-protected-resource';

function createToolCallMessage(toolName: string, args: Record<string, unknown> = {}, id: string | number = 'call-1'): JSONRPCMessage {
    return {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: args },
        id
    } as JSONRPCMessage;
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

describe('Scope Challenge / Step-Up Auth', () => {
    let transport: WebStandardStreamableHTTPServerTransport;
    let mcpServer: McpServer;

    afterEach(async () => {
        await transport.close();
    });

    async function initializeServer(): Promise<string> {
        const request = createRequest('POST', INITIALIZE_MESSAGE);
        const response = await transport.handleRequest(request);
        expect(response.status).toBe(200);
        const sessionId = response.headers.get('mcp-session-id');
        expect(sessionId).toBeDefined();
        return sessionId as string;
    }

    function setupServer(options: {
        scopeChallenge?: {
            resourceMetadataUrl: string;
            buildErrorDescription?: (toolName: string, requiredScopes: string[]) => string;
        };
        tools?: Array<{
            name: string;
            scopes?: string[] | { required: string[]; accepted?: string[] };
            schema?: z.ZodObject<{ name: z.ZodString }>;
        }>;
        toolScopeOverrides?: Record<string, string[] | { required: string[]; accepted?: string[] }>;
    }): void {
        mcpServer = new McpServer({ name: 'scope-test-server', version: '1.0.0' }, { capabilities: { logging: {} } });

        const tools = options.tools ?? [
            { name: 'public_tool' },
            { name: 'read_repo', scopes: ['repo:read'] },
            { name: 'write_repo', scopes: { required: ['repo:write'], accepted: ['repo:write', 'repo'] } }
        ];

        for (const tool of tools) {
            mcpServer.registerTool(
                tool.name,
                {
                    description: `Test tool: ${tool.name}`,
                    inputSchema: tool.schema ?? z.object({ name: z.string() }),
                    scopes: tool.scopes
                },
                async ({ name }): Promise<CallToolResult> => {
                    return { content: [{ type: 'text', text: `Result from ${tool.name}: ${name}` }] };
                }
            );
        }

        if (options.toolScopeOverrides) {
            for (const [toolName, scopes] of Object.entries(options.toolScopeOverrides)) {
                mcpServer.setToolScopes(toolName, scopes);
            }
        }

        transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            scopeChallenge: options.scopeChallenge
        });
    }

    describe('HTTP 403 scope challenge responses', () => {
        beforeEach(async () => {
            setupServer({
                scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
            });
            await mcpServer.connect(transport);
        });

        it('should return 403 when token lacks required scopes', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: ['user:read']
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(403);

            const wwwAuth = response.headers.get('WWW-Authenticate');
            expect(wwwAuth).toBeDefined();
            expect(wwwAuth).toContain('error="insufficient_scope"');
            expect(wwwAuth).toContain('scope="user:read repo:read"');
            expect(wwwAuth).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);

            const body = (await response.json()) as { jsonrpc: string; error: { code: number; message: string } };
            expect(body.jsonrpc).toBe('2.0');
            expect(body.error.code).toBe(-32600);
            expect(body.error.message).toContain('Insufficient scope');
            expect(body.error.message).toContain('read_repo');
        });

        it('should pass when token has a required scope', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: ['repo:read']
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            // Should NOT be 403 — tool should execute
            expect(response.status).toBe(200);
        });

        it('should pass when token has an accepted (parent) scope', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: ['repo'] // parent scope — accepted by write_repo
            };

            const request = createRequest('POST', createToolCallMessage('write_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(200);
        });

        it('should pass through tools with no scope configuration', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: [] // no scopes at all
            };

            const request = createRequest('POST', createToolCallMessage('public_tool', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(200);
        });

        it('should pass through non-tools/call requests', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: []
            };

            const listToolsMsg: JSONRPCMessage = {
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 'list-1'
            } as JSONRPCMessage;

            const request = createRequest('POST', listToolsMsg, { sessionId });
            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(200);
        });

        it('should include recommended scopes as union of existing + required', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: ['user:read', 'user:write']
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(403);
            const wwwAuth = response.headers.get('WWW-Authenticate')!;
            // Should contain all existing scopes + the required one
            expect(wwwAuth).toContain('user:read');
            expect(wwwAuth).toContain('user:write');
            expect(wwwAuth).toContain('repo:read');
        });
    });

    describe('without scope challenge configured', () => {
        beforeEach(async () => {
            setupServer({}); // no scopeChallenge
            await mcpServer.connect(transport);
        });

        it('should pass through all tools/call requests when scope challenge is not configured', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: []
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            // Without scopeChallenge configured, scope check is skipped
            expect(response.status).toBe(200);
        });
    });

    describe('setToolScopes override', () => {
        it('should use overridden scopes from setToolScopes instead of registration scopes', async () => {
            setupServer({
                scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL },
                tools: [{ name: 'read_repo', scopes: ['repo:read'] }],
                toolScopeOverrides: {
                    read_repo: ['admin:repo'] // Override: now requires admin:repo instead
                }
            });
            await mcpServer.connect(transport);
            const sessionId = await initializeServer();

            // Token has repo:read (the original scope), but not admin:repo (the override)
            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: ['repo:read']
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            // Should be 403 because the override requires admin:repo
            expect(response.status).toBe(403);
            const wwwAuth = response.headers.get('WWW-Authenticate')!;
            expect(wwwAuth).toContain('admin:repo');
        });

        it('should allow setting scopes on tools that had no scopes at registration', async () => {
            setupServer({
                scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL },
                tools: [
                    { name: 'public_tool' } // No scopes at registration
                ],
                toolScopeOverrides: {
                    public_tool: ['admin:read'] // Now requires scopes
                }
            });
            await mcpServer.connect(transport);
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: []
            };

            const request = createRequest('POST', createToolCallMessage('public_tool', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(403);
        });
    });

    describe('custom error description', () => {
        it('should use buildErrorDescription when provided', async () => {
            setupServer({
                scopeChallenge: {
                    resourceMetadataUrl: RESOURCE_METADATA_URL,
                    buildErrorDescription: (toolName, requiredScopes) => `Tool "${toolName}" needs: ${requiredScopes.join(', ')}`
                }
            });
            await mcpServer.connect(transport);
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: []
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(403);
            const wwwAuth = response.headers.get('WWW-Authenticate')!;
            expect(wwwAuth).toContain('Tool "read_repo" needs: repo:read');
        });
    });

    describe('batch requests', () => {
        beforeEach(async () => {
            setupServer({
                scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
            });
            await mcpServer.connect(transport);
        });

        it('should reject the entire batch if any tools/call lacks scopes', async () => {
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: []
            };

            const batch: JSONRPCMessage[] = [
                createToolCallMessage('public_tool', { name: 'ok' }, 'call-1'),
                createToolCallMessage('read_repo', { name: 'fail' }, 'call-2')
            ];

            const request = createRequest('POST', batch, { sessionId });
            const response = await transport.handleRequest(request, { authInfo });

            expect(response.status).toBe(403);
        });
    });

    describe('McpServer scope API', () => {
        it('getToolScopes returns undefined for tools without scopes', () => {
            mcpServer = new McpServer({ name: 'test', version: '1.0.0' });
            mcpServer.registerTool(
                'no_scopes',
                {
                    description: 'No scopes',
                    inputSchema: z.object({ x: z.string() })
                },
                async () => ({ content: [] })
            );

            expect(mcpServer.getToolScopes('no_scopes')).toBeUndefined();
        });

        it('getToolScopes returns normalized scopes from string[] registration', () => {
            mcpServer = new McpServer({ name: 'test', version: '1.0.0' });
            mcpServer.registerTool(
                'scoped',
                {
                    description: 'Scoped',
                    inputSchema: z.object({ x: z.string() }),
                    scopes: ['repo:read', 'repo:write']
                },
                async () => ({ content: [] })
            );

            const scopes = mcpServer.getToolScopes('scoped');
            expect(scopes).toEqual({ required: ['repo:read', 'repo:write'] });
        });

        it('getToolScopes returns full config from object registration', () => {
            mcpServer = new McpServer({ name: 'test', version: '1.0.0' });
            mcpServer.registerTool(
                'scoped',
                {
                    description: 'Scoped',
                    inputSchema: z.object({ x: z.string() }),
                    scopes: { required: ['public_repo'], accepted: ['public_repo', 'repo'] }
                },
                async () => ({ content: [] })
            );

            const scopes = mcpServer.getToolScopes('scoped');
            expect(scopes).toEqual({ required: ['public_repo'], accepted: ['public_repo', 'repo'] });
        });

        it('setToolScopes overrides registration scopes', () => {
            mcpServer = new McpServer({ name: 'test', version: '1.0.0' });
            mcpServer.registerTool(
                'scoped',
                {
                    description: 'Scoped',
                    inputSchema: z.object({ x: z.string() }),
                    scopes: ['repo:read']
                },
                async () => ({ content: [] })
            );

            mcpServer.setToolScopes('scoped', ['admin:repo']);

            const scopes = mcpServer.getToolScopes('scoped');
            expect(scopes).toEqual({ required: ['admin:repo'] });
        });

        it('setToolScopes can set scopes on unregistered tool names', () => {
            mcpServer = new McpServer({ name: 'test', version: '1.0.0' });
            mcpServer.setToolScopes('future_tool', ['admin:read']);

            // Returns the override even if tool isn't registered yet
            const scopes = mcpServer.getToolScopes('future_tool');
            expect(scopes).toEqual({ required: ['admin:read'] });
        });
    });

    describe('auto-wiring', () => {
        it('should auto-wire scope resolver on connect when transport supports it', async () => {
            setupServer({
                scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
            });

            // Before connect, the transport has no resolver — scope checks should pass
            // We verify this indirectly: after connect, scope checks work
            await mcpServer.connect(transport);
            const sessionId = await initializeServer();

            const authInfo: AuthInfo = {
                token: 'test-token',
                clientId: 'test-client',
                scopes: []
            };

            const request = createRequest('POST', createToolCallMessage('read_repo', { name: 'test' }), { sessionId });

            const response = await transport.handleRequest(request, { authInfo });

            // If auto-wiring didn't work, this would pass through
            expect(response.status).toBe(403);
        });
    });
});
