import { randomUUID } from 'node:crypto';

import type { AuthInfo, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import type { ToolScopeConfig, ToolScopePolicy } from '../../src/server/scopeChallenge';
import { evaluateScopePolicy, normalizeToolScopePolicy } from '../../src/server/scopeChallenge';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

const RESOURCE_METADATA_URL = 'https://auth.example.com/.well-known/oauth-protected-resource';

function toolCall(name = 'operate', args: Record<string, unknown> = {}, id: string | number = 'call-1'): JSONRPCRequest {
    return {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name, arguments: args },
        id
    };
}

function policy(anyOf: ToolScopePolicy['anyOf'], select?: ToolScopePolicy['select']): ToolScopePolicy {
    return normalizeToolScopePolicy({ anyOf, ...(select !== undefined && { select }) });
}

describe('tool scope policy', () => {
    it('normalizes string[] as one AND path', () => {
        const normalized = normalizeToolScopePolicy(['repo:read', 'org:read']);
        expect(normalized).toEqual({
            anyOf: [
                {
                    name: 'default',
                    allOf: [
                        { challenge: 'repo:read', anyOf: [] },
                        { challenge: 'org:read', anyOf: [] }
                    ]
                }
            ]
        });
        expect(evaluateScopePolicy(normalized, ['repo:read'], toolCall()).kind).toBe('challenge');
        expect(evaluateScopePolicy(normalized, ['repo:read', 'org:read'], toolCall()).kind).toBe('allow');
    });

    it('evaluates policy anyOf as OR, path allOf as AND, and entry anyOf as exact OR alternatives', () => {
        const normalized = policy([
            {
                name: 'repository',
                allOf: [
                    { challenge: 'repo:read', anyOf: ['repo'] },
                    { challenge: 'org:read', anyOf: ['org:admin'] }
                ]
            },
            {
                name: 'public',
                allOf: [{ challenge: 'public_repo', anyOf: [] }]
            }
        ]);

        expect(evaluateScopePolicy(normalized, ['repo', 'org:admin'], toolCall())).toEqual({
            kind: 'allow',
            pathName: 'repository'
        });
        expect(evaluateScopePolicy(normalized, ['public_repo'], toolCall())).toEqual({
            kind: 'allow',
            pathName: 'public'
        });
        expect(evaluateScopePolicy(normalized, ['repo:write', 'org:admin'], toolCall())).toEqual({
            kind: 'challenge',
            pathName: 'repository',
            scopes: ['repo:read', 'org:admin']
        });
    });

    it('uses the first declared selected path and emits its complete concrete scope set', () => {
        const normalized = policy(
            [
                {
                    name: 'preferred',
                    allOf: [
                        { challenge: 'repo:read', anyOf: ['repo'] },
                        { challenge: 'issues:write', anyOf: ['issues'] }
                    ]
                },
                {
                    name: 'fallback',
                    allOf: [{ challenge: 'admin', anyOf: [] }]
                }
            ],
            () => ['fallback', 'preferred']
        );

        expect(evaluateScopePolicy(normalized, ['repo'], toolCall())).toEqual({
            kind: 'challenge',
            pathName: 'preferred',
            scopes: ['repo', 'issues:write']
        });
    });

    it('passes the full request to the selector and supports undefined to defer to input validation', () => {
        const select = vi.fn((request: JSONRPCRequest) => {
            const args = (request.params as { arguments?: { mode?: unknown } }).arguments;
            return typeof args?.mode === 'string' ? [args.mode] : undefined;
        });
        const normalized = policy(
            [
                { name: 'read', allOf: [{ challenge: 'repo:read', anyOf: [] }] },
                { name: 'write', allOf: [{ challenge: 'repo:write', anyOf: [] }] }
            ],
            select
        );
        const request = toolCall('operate', { mode: 'write', nested: { value: 42 } }, 17);

        expect(evaluateScopePolicy(normalized, [], request)).toEqual({
            kind: 'challenge',
            pathName: 'write',
            scopes: ['repo:write']
        });
        expect(select).toHaveBeenCalledWith(request);
        expect(evaluateScopePolicy(normalized, [], toolCall('operate', { mode: 42 }))).toEqual({ kind: 'skip' });
    });

    it('treats canonical challenge scopes as accepted without inferring any hierarchy', () => {
        const normalized = policy([
            {
                name: 'exact',
                allOf: [{ challenge: 'repo:read', anyOf: ['repo'] }]
            }
        ]);
        expect(evaluateScopePolicy(normalized, ['repo:read'], toolCall()).kind).toBe('allow');
        expect(evaluateScopePolicy(normalized, ['repo:read:all'], toolCall())).toEqual({
            kind: 'challenge',
            pathName: 'exact',
            scopes: ['repo:read']
        });
    });

    it('rejects malformed policies and selector results', () => {
        expect(() => normalizeToolScopePolicy({ anyOf: [] })).toThrow('at least one anyOf path');
        expect(() =>
            normalizeToolScopePolicy({
                anyOf: [
                    { name: 'same', allOf: [] },
                    { name: 'same', allOf: [] }
                ]
            })
        ).toThrow('duplicated');

        const emptySelection = policy([{ name: 'read', allOf: [] }], () => []);
        expect(() => evaluateScopePolicy(emptySelection, [], toolCall())).toThrow('at least one declared path');

        const unknownSelection = policy([{ name: 'read', allOf: [] }], () => ['missing']);
        expect(() => evaluateScopePolicy(unknownSelection, [], toolCall())).toThrow("unknown path 'missing'");
    });
});

interface LegacyHarness {
    server: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
    calls: ReturnType<typeof vi.fn>;
}

async function createLegacyHarness(scopes: ToolScopeConfig): Promise<LegacyHarness> {
    const calls = vi.fn();
    const server = new McpServer({ name: 'scope-test', version: '1.0.0' });
    server.registerTool(
        'operate',
        {
            inputSchema: z.object({ mode: z.string().optional() }),
            scopes
        },
        async args => {
            calls(args);
            return { content: [{ type: 'text', text: 'ok' }] };
        }
    );
    server.registerTool('public', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'public' }] }));
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        scopeChallenge: { resourceMetadataUrl: RESOURCE_METADATA_URL }
    });
    await server.connect(transport);
    return { server, transport, calls };
}

async function initializeLegacy(transport: WebStandardStreamableHTTPServerTransport): Promise<string> {
    const request = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                clientInfo: { name: 'test-client', version: '1.0' },
                protocolVersion: '2025-11-25',
                capabilities: {}
            },
            id: 'init'
        })
    });
    const response = await transport.handleRequest(request);
    return response.headers.get('mcp-session-id')!;
}

function legacyRequest(body: JSONRPCMessage | JSONRPCMessage[], sessionId: string): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            'mcp-protocol-version': '2025-11-25'
        },
        body: JSON.stringify(body)
    });
}

describe('legacy Streamable HTTP scope preflight', () => {
    it('challenges an authenticated zero-scope token but leaves authentication to the auth gate', async () => {
        const harness = await createLegacyHarness(['repo:read']);
        const sessionId = await initializeLegacy(harness.transport);
        const request = legacyRequest(toolCall(), sessionId);

        const anonymous = await harness.transport.handleRequest(request.clone());
        expect(anonymous.status).toBe(200);

        const authenticated = await harness.transport.handleRequest(request, {
            authInfo: { token: 'token', clientId: 'client', scopes: [] }
        });
        expect(authenticated.status).toBe(403);
        expect(authenticated.headers.get('WWW-Authenticate')).toContain('scope="repo:read"');
        expect(harness.calls).toHaveBeenCalledTimes(1);
        await harness.transport.close();
    });

    it('allows a zero-requirement path and keeps scoped tools discoverable', async () => {
        const harness = await createLegacyHarness({
            anyOf: [{ name: 'public', allOf: [] }]
        });
        const sessionId = await initializeLegacy(harness.transport);
        const authInfo: AuthInfo = { token: 'token', clientId: 'client', scopes: [] };

        const listResponse = await harness.transport.handleRequest(
            legacyRequest({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: 'list' }, sessionId),
            { authInfo }
        );
        const listBody = (await listResponse.json()) as { result: { tools: Array<{ name: string }> } };
        expect(listBody.result.tools.map(tool => tool.name)).toEqual(['operate', 'public']);

        const callResponse = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), { authInfo });
        expect(callResponse.status).toBe(200);
        await harness.transport.close();
    });

    it('rejects a whole batch on the first insufficient call and emits a null response id', async () => {
        const harness = await createLegacyHarness(['repo:read']);
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(
            legacyRequest(
                [
                    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'public', arguments: {} }, id: 'public' },
                    toolCall('operate', {}, 'scoped')
                ],
                sessionId
            ),
            { authInfo: { token: 'token', clientId: 'client', scopes: [] } }
        );
        expect(response.status).toBe(403);
        expect(((await response.json()) as { id: unknown }).id).toBeNull();
        expect(harness.calls).not.toHaveBeenCalled();
        await harness.transport.close();
    });

    it('fails closed when a selector returns an unknown path', async () => {
        const onerror = vi.fn();
        const harness = await createLegacyHarness(
            policy([{ name: 'read', allOf: [{ challenge: 'repo:read', anyOf: [] }] }], () => ['missing'])
        );
        harness.transport.onerror = onerror;
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), {
            authInfo: { token: 'token', clientId: 'client', scopes: [] }
        });
        expect(response.status).toBe(500);
        expect(harness.calls).not.toHaveBeenCalled();
        expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('unknown path') }));
        await harness.transport.close();
    });

    it('tracks policy changes across the registered-tool lifecycle', () => {
        const server = new McpServer({ name: 'scope-test', version: '1.0.0' });
        const tool = server.registerTool('mutable', { scopes: ['repo:read'] }, async () => ({ content: [] }));
        expect(server.getToolScopes('mutable')).toEqual(normalizeToolScopePolicy(['repo:read']));
        tool.disable();
        expect(server.getToolScopes('mutable')).toBeUndefined();
        tool.enable();
        tool.update({ scopes: ['repo:write'] });
        expect(server.getToolScopes('mutable')).toEqual(normalizeToolScopePolicy(['repo:write']));
        tool.update({ scopes: null });
        expect(server.getToolScopes('mutable')).toBeUndefined();
        tool.remove();
        expect(server.getToolScopes('mutable')).toBeUndefined();
    });

    it('escapes challenge auth-params', async () => {
        const server = new McpServer({ name: 'scope-test', version: '1.0.0' });
        server.registerTool('operate', { scopes: ['repo:read'] }, async () => ({ content: [] }));
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            scopeChallenge: {
                resourceMetadataUrl: RESOURCE_METADATA_URL,
                buildErrorDescription: () => 'Needs "repo:read", path\\to\\thing'
            }
        });
        await server.connect(transport);
        const sessionId = await initializeLegacy(transport);
        const response = await transport.handleRequest(legacyRequest(toolCall(), sessionId), {
            authInfo: { token: 'token', clientId: 'client', scopes: [] }
        });
        expect(response.headers.get('WWW-Authenticate')).toContain('error_description="Needs \\"repo:read\\", path\\\\to\\\\thing"');
        await transport.close();
    });
});
