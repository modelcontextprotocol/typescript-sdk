import { randomUUID } from 'node:crypto';

import type { AuthInfo, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import type { ScopeChallengeHandler } from '../../src/server/scopeChallenge';
import { requireScopes } from '../../src/server/scopeChallenge';
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

function auth(scopes: string[], resourceMetadataUrl?: string): AuthInfo {
    return { token: 'token', clientId: 'client', scopes, ...(resourceMetadataUrl !== undefined && { resourceMetadataUrl }) };
}

describe('requireScopes', () => {
    it('requires every supplied scope using exact matches', async () => {
        const handler = requireScopes('repo:read', 'org:read');
        const request = toolCall();

        expect(await handler({ request, authInfo: auth(['repo:read']) })).toEqual({
            scopes: ['repo:read', 'org:read']
        });
        expect(await handler({ request, authInfo: auth(['repo:read', 'org:read']) })).toBeUndefined();
        expect(await handler({ request, authInfo: auth(['repo:read:all', 'org:read']) })).toEqual({
            scopes: ['repo:read', 'org:read']
        });
    });

    it('leaves unauthenticated requests to the authentication gate', async () => {
        expect(await requireScopes('repo:read')({ request: toolCall() })).toBeUndefined();
    });

    it('rejects invalid static scope declarations', () => {
        expect(() => (requireScopes as (...scopes: string[]) => ScopeChallengeHandler)()).toThrow('at least one');
        for (const scope of ['repo read', 'repo"read', String.raw`repo\read`, 'repo:read🚀']) {
            expect(() => requireScopes(scope)).toThrow('scope-token grammar');
        }
    });
});

interface LegacyHarness {
    server: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
    calls: ReturnType<typeof vi.fn>;
}

async function createLegacyHarness(scopeChallenge: ScopeChallengeHandler): Promise<LegacyHarness> {
    const calls = vi.fn();
    const server = new McpServer({ name: 'scope-test', version: '1.0.0' });
    server.registerTool(
        'operate',
        {
            inputSchema: z.object({ mode: z.string().optional() }),
            scopeChallenge
        },
        async args => {
            calls(args);
            return { content: [{ type: 'text', text: 'ok' }] };
        }
    );
    server.registerTool('public', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'public' }] }));
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true
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
    it('awaits the callback with the full request and auth info before dispatch', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(async ({ request, authInfo }) => {
            await Promise.resolve();
            const mode = (request.params as { arguments?: { mode?: unknown } }).arguments?.mode;
            return mode === 'write' && !authInfo?.scopes.includes('repo:write')
                ? { scopes: ['repo:write'], errorDescription: 'Write access is required' }
                : undefined;
        });
        const harness = await createLegacyHarness(callback);
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(
            legacyRequest(toolCall('operate', { mode: 'write', nested: { value: 42 } }), sessionId),
            { authInfo: auth(['repo:read'], RESOURCE_METADATA_URL) }
        );

        expect(response.status).toBe(403);
        const challenge = response.headers.get('WWW-Authenticate');
        expect(challenge).toContain('scope="repo:write"');
        expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
        expect(challenge).toContain('error_description="Write access is required"');
        expect(callback).toHaveBeenCalledWith({
            request: expect.objectContaining({
                method: 'tools/call',
                params: { name: 'operate', arguments: { mode: 'write', nested: { value: 42 } } }
            }),
            authInfo: auth(['repo:read'], RESOURCE_METADATA_URL)
        });
        expect(harness.calls).not.toHaveBeenCalled();
        await harness.transport.close();
    });

    it('rejects a whole batch on the first challenge before any member executes', async () => {
        const callback = vi.fn<ScopeChallengeHandler>(requireScopes('repo:read'));
        const harness = await createLegacyHarness(callback);
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(
            legacyRequest(
                [
                    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'public', arguments: {} }, id: 'public' },
                    toolCall('operate', {}, 'scoped')
                ],
                sessionId
            ),
            { authInfo: auth([]) }
        );

        expect(response.status).toBe(403);
        expect(((await response.json()) as { id: unknown }).id).toBeNull();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(harness.calls).not.toHaveBeenCalled();
        await harness.transport.close();
    });

    it('fails closed when a callback rejects or returns invalid scopes', async () => {
        for (const callback of [
            vi.fn<ScopeChallengeHandler>(async () => {
                throw new Error('scope lookup failed');
            }),
            vi.fn<ScopeChallengeHandler>(() => ({ scopes: [] as unknown as [string, ...string[]] })),
            vi.fn<ScopeChallengeHandler>(() => ({ scopes: ['repo:read🚀'] })),
            vi.fn<ScopeChallengeHandler>(() => ({ scopes: ['repo:read'], errorDescription: '' })),
            vi.fn<ScopeChallengeHandler>(() => ({ scopes: ['repo:read'], errorDescription: 'Need "repo:read"' })),
            vi.fn<ScopeChallengeHandler>(() => ({ scopes: ['repo:read'], errorDescription: String.raw`Need repo\read` })),
            vi.fn<ScopeChallengeHandler>(() => ({ scopes: ['repo:read'], errorDescription: 'Need 🚀 access' }))
        ]) {
            const harness = await createLegacyHarness(callback);
            const onerror = vi.fn();
            harness.transport.onerror = onerror;
            const sessionId = await initializeLegacy(harness.transport);
            const response = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), {
                authInfo: auth([])
            });

            expect(response.status).toBe(500);
            expect(harness.calls).not.toHaveBeenCalled();
            expect(onerror).toHaveBeenCalledOnce();
            await harness.transport.close();
        }
    });

    it('tracks callback changes across the registered-tool lifecycle', async () => {
        const server = new McpServer({ name: 'scope-test', version: '1.0.0' });
        const initial = requireScopes('repo:read');
        const updated = requireScopes('repo:write');
        const tool = server.registerTool('mutable', { scopeChallenge: initial }, async () => ({ content: [] }));

        expect(await server.resolveScopeChallenge({ request: toolCall('mutable'), authInfo: auth([]) })).toEqual({
            scopes: ['repo:read']
        });
        tool.disable();
        expect(await server.resolveScopeChallenge({ request: toolCall('mutable'), authInfo: auth([]) })).toBeUndefined();
        tool.enable();
        tool.update({ scopeChallenge: updated });
        expect(await server.resolveScopeChallenge({ request: toolCall('mutable'), authInfo: auth([]) })).toEqual({
            scopes: ['repo:write']
        });
        tool.update({ scopeChallenge: null });
        expect(await server.resolveScopeChallenge({ request: toolCall('mutable'), authInfo: auth([]) })).toBeUndefined();
        tool.remove();
        expect(await server.resolveScopeChallenge({ request: toolCall('mutable'), authInfo: auth([]) })).toBeUndefined();
    });

    it('serializes an optional challenge description', async () => {
        const harness = await createLegacyHarness(() => ({
            scopes: ['repo:read'],
            errorDescription: 'Needs repo:read, path/to/thing'
        }));
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), {
            authInfo: auth([])
        });

        expect(response.headers.get('WWW-Authenticate')).toContain('error_description="Needs repo:read, path/to/thing"');
        await harness.transport.close();
    });

    it('omits resource_metadata when the auth info carries no metadata URL', async () => {
        const harness = await createLegacyHarness(requireScopes('repo:write'));
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), {
            authInfo: auth(['repo:read'])
        });

        expect(response.status).toBe(403);
        const challenge = response.headers.get('WWW-Authenticate');
        expect(challenge).toContain('scope="repo:write"');
        expect(challenge).not.toContain('resource_metadata');
        await harness.transport.close();
    });

    it('derives resource_metadata from the RFC 8707 resource identifier when no URL was stamped', async () => {
        const harness = await createLegacyHarness(requireScopes('repo:write'));
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), {
            authInfo: { ...auth(['repo:read']), resource: new URL('https://api.example.com/mcp?tenant=acme') }
        });

        expect(response.status).toBe(403);
        expect(response.headers.get('WWW-Authenticate')).toContain(
            'resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp?tenant=acme"'
        );
        await harness.transport.close();
    });

    it('omits resource_metadata when an abstract RFC 8707 resource identifier cannot locate an RFC 9728 document', async () => {
        const harness = await createLegacyHarness(requireScopes('repo:write'));
        const sessionId = await initializeLegacy(harness.transport);
        const response = await harness.transport.handleRequest(legacyRequest(toolCall(), sessionId), {
            authInfo: { ...auth(['repo:read']), resource: new URL('urn:example:mcp') }
        });

        expect(response.status).toBe(403);
        expect(response.headers.get('WWW-Authenticate')).not.toContain('resource_metadata');
        await harness.transport.close();
    });
});
