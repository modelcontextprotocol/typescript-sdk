/**
 * Bearer auth composed with the dual-era HTTP entry (`createMcpHandler`), and
 * per-request HTTP context exposure on it. These are the entry-side siblings of
 * `hosting:auth:authinfo-propagates` / `hosting:auth:missing-401` /
 * `hosting:context:web-request-headers`, whose bodies hand-host an Express or
 * per-session stack and so never reach `createMcpHandler` when given an entry
 * arm.
 *
 * The SDK does not enforce endpoint authentication on either era — bearer auth
 * is deployer-composed middleware in front of whichever handler is mounted.
 * The composition under test here is the documented one: a user-shaped gate
 * verifies the Authorization header and, on success, hands the verified
 * `AuthInfo` to `handler.fetch(request, { authInfo })`. The entry never derives
 * `authInfo` from request headers; it is strictly pass-through to the factory's
 * per-request context and to handler `ctx.http.authInfo`. Each cell hosts the
 * composition itself behind an in-process fetch (the wire() entry arm has no
 * hook for the gate or for client-transport requestInit), and the matrix arm
 * selects which leg of the entry serves the authenticated traffic
 * (`entryStateless` → a plain client through the stateless legacy fallback;
 * `entryModern` → a 2026-07-28-pinned client through the modern-only strict
 * path).
 */
import { Client, InsufficientScopeError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { AuthInfo, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const MODERN = '2026-07-28';
const VALID_TOKEN = 'e2e-entry-access-token';

/** What the user's verifier derives from the Authorization header (a fresh object per request, so the assertion checks delivery, not identity). */
function verifyBearer(header: string | null): AuthInfo | undefined {
    if (header !== `Bearer ${VALID_TOKEN}`) return undefined;
    return {
        token: VALID_TOKEN,
        clientId: 'e2e-entry-caller',
        scopes: ['mcp:tools:read', 'mcp:tools:call'],
        extra: { userId: 'user-42' }
    };
}

/** The 401 a bearer gate answers a missing/invalid token with (mirrors the spec's WWW-Authenticate discovery shape). */
function unauthorized(): Response {
    return Response.json(
        { error: 'invalid_token' },
        {
            status: 401,
            headers: {
                'content-type': 'application/json',
                'www-authenticate':
                    'Bearer error="invalid_token", resource_metadata="http://in-process/.well-known/oauth-protected-resource"'
            }
        }
    );
}

verifies('typescript:hosting:entry:auth:missing-401', async ({ transport }: TestArgs) => {
    let factoryCalls = 0;
    const factory = (_ctx?: McpRequestContext): McpServer => {
        factoryCalls++;
        const server = new McpServer({ name: 'e2e-entry-auth', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('whoami', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'reached' }] }));
        return server;
    };

    const handler = createMcpHandler(factory, { legacy: transport === 'entryStateless' ? 'stateless' : 'reject' });
    await using _ = { [Symbol.asyncDispose]: () => handler.close() };

    // The documented bearer-gate composition in front of the entry.
    const gatedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(url, init);
        const authInfo = verifyBearer(request.headers.get('authorization'));
        if (authInfo === undefined) return unauthorized();
        return handler.fetch(request, { authInfo });
    };

    // 1. Raw probe without an Authorization header: the gate answers 401 with
    //    the WWW-Authenticate challenge, and the entry is never reached.
    const probe = await gatedFetch('http://in-process/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(probe.status).toBe(401);
    const wwwAuthenticate = probe.headers.get('www-authenticate');
    expect(wwwAuthenticate).toContain('Bearer');
    expect(wwwAuthenticate).toContain('resource_metadata');
    expect(factoryCalls).toBe(0);

    // 2. The plain SDK client (no Authorization on its requestInit) cannot
    //    connect through the gate on either leg, and the entry is still never
    //    reached. The exact connect-time error surface (401 wrapped by the
    //    legacy POST or by the modern discover negotiation) is a client-auth
    //    concern; this cell pins only that the gate composes — connect rejects
    //    and no factory call runs.
    const plainClient = new Client({ name: 'plain-client', version: '1.0.0' });
    if (transport === 'entryModern') plainClient.setVersionNegotiation({ mode: { pin: MODERN } });
    try {
        await expect(
            plainClient.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: gatedFetch }))
        ).rejects.toThrow();
    } finally {
        await plainClient.close().catch(() => {});
    }
    expect(factoryCalls).toBe(0);
});

verifies('typescript:hosting:entry:auth:authinfo-propagates', async ({ transport }: TestArgs) => {
    // Recorders live outside the per-request factory.
    const seenByFactory: Array<AuthInfo | undefined> = [];
    const seenByTool: Array<AuthInfo | undefined> = [];

    const factory = (ctx?: McpRequestContext): McpServer => {
        seenByFactory.push(ctx?.authInfo);
        const server = new McpServer({ name: 'e2e-entry-auth', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool(
            'whoami',
            { description: 'Reports the authenticated caller derived from ctx.http.authInfo.', inputSchema: z.object({}) },
            (_args, handlerCtx) => {
                seenByTool.push(handlerCtx.http?.authInfo);
                return {
                    content: [
                        {
                            type: 'text',
                            text: handlerCtx.http?.authInfo
                                ? `${handlerCtx.http.authInfo.clientId} [${handlerCtx.http.authInfo.scopes.join(' ')}] (${ctx?.era ?? 'unknown'})`
                                : 'no-auth-info'
                        }
                    ]
                };
            }
        );
        return server;
    };

    const handler = createMcpHandler(factory, { legacy: transport === 'entryStateless' ? 'stateless' : 'reject' });
    const gatedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(url, init);
        const authInfo = verifyBearer(request.headers.get('authorization'));
        if (authInfo === undefined) return unauthorized();
        return handler.fetch(request, { authInfo });
    };

    const client = new Client({ name: 'auth-client', version: '1.0.0' });
    if (transport === 'entryModern') client.setVersionNegotiation({ mode: { pin: MODERN } });
    await using _ = {
        [Symbol.asyncDispose]: async () => {
            await client.close().catch(() => {});
            await handler.close();
        }
    };

    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
            fetch: gatedFetch,
            requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
        })
    );
    if (transport === 'entryModern') expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBeFalsy();
    const era = transport === 'entryStateless' ? 'legacy' : 'modern';
    expect(result.content).toEqual([{ type: 'text', text: `e2e-entry-caller [mcp:tools:read mcp:tools:call] (${era})` }]);

    // The verified AuthInfo handed to handler.fetch(request, { authInfo })
    // reached the tool handler's ctx.http.authInfo unchanged — not dropped, not
    // replaced by a placeholder, not derived from a header.
    expect(seenByTool).toHaveLength(1);
    expect(seenByTool[0]).toEqual({
        token: VALID_TOKEN,
        clientId: 'e2e-entry-caller',
        scopes: ['mcp:tools:read', 'mcp:tools:call'],
        extra: { userId: 'user-42' }
    });

    // ...and the same AuthInfo was on the factory's per-request context for
    // every instance the entry built (negotiation + the tools/call), so a
    // factory keying surface off authInfo sees it on the leg under test.
    expect(seenByFactory.length).toBeGreaterThan(0);
    for (const seen of seenByFactory) {
        expect(seen).toEqual({
            token: VALID_TOKEN,
            clientId: 'e2e-entry-caller',
            scopes: ['mcp:tools:read', 'mcp:tools:call'],
            extra: { userId: 'user-42' }
        });
    }
});

verifies('typescript:hosting:entry:ctx-http-req-headers', async ({ transport }: TestArgs) => {
    const PROBE_HEADER = 'x-e2e-probe';
    const PROBE_VALUE = 'probe-7d1f';
    const seenByTool: Array<{ isFetchHeaders: boolean; probe: string | null }> = [];

    const factory = (_ctx?: McpRequestContext): McpServer => {
        const server = new McpServer({ name: 'e2e-entry-ctx', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('read-probe-header', { inputSchema: z.object({}) }, (_args, ctx) => {
            const headers = ctx.http?.req?.headers;
            seenByTool.push({
                isFetchHeaders: headers instanceof Headers,
                probe: headers instanceof Headers ? headers.get(PROBE_HEADER) : null
            });
            return { content: [{ type: 'text', text: headers?.get(PROBE_HEADER) ?? '<missing>' }] };
        });
        return server;
    };

    const handler = createMcpHandler(factory, { legacy: transport === 'entryStateless' ? 'stateless' : 'reject' });
    const client = new Client({ name: 'ctx-client', version: '1.0.0' });
    if (transport === 'entryModern') client.setVersionNegotiation({ mode: { pin: MODERN } });
    await using _ = {
        [Symbol.asyncDispose]: async () => {
            await client.close().catch(() => {});
            await handler.close();
        }
    };

    await client.connect(
        new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
            fetch: (url, init) => handler.fetch(new Request(url, init)),
            requestInit: { headers: { [PROBE_HEADER]: PROBE_VALUE } }
        })
    );

    const result = await client.callTool({ name: 'read-probe-header', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: PROBE_VALUE }]);
    // The custom header set on the client transport is readable as Fetch
    // Headers inside the handler on the leg the matrix arm selected.
    expect(seenByTool).toEqual([{ isFetchHeaders: true, probe: PROBE_VALUE }]);
});

verifies('typescript:hosting:entry:auth:insufficient-scope-403', async ({ transport }: TestArgs) => {
    // Per-operation scope requirements derived from the body's tool name. On the
    // modern leg the gate reads the SEP-2243 standard `Mcp-Method` / `Mcp-Name`
    // headers (the entry's documented per-operation routing surface); the legacy
    // leg has no such header so the gate falls back to one required scope.
    const REQUIRED_BY_TOOL: Record<string, string> = { 'write-file': 'files:write' };
    const TOKEN_SCOPES: Record<string, string[]> = {
        'read-only-token': ['files:read'],
        'read-write-token': ['files:read', 'files:write']
    };

    let factoryCalls = 0;
    const factory = (ctx?: McpRequestContext): McpServer => {
        factoryCalls++;
        const server = new McpServer({ name: 'e2e-entry-scoped', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('list-files', { inputSchema: z.object({}) }, () => ({
            content: [{ type: 'text', text: `listed by ${ctx?.authInfo?.clientId}` }]
        }));
        server.registerTool('write-file', { inputSchema: z.object({}) }, () => ({
            content: [{ type: 'text', text: `written by ${ctx?.authInfo?.clientId}` }]
        }));
        return server;
    };

    const handler = createMcpHandler(factory, { legacy: transport === 'entryStateless' ? 'stateless' : 'reject' });
    await using _ = { [Symbol.asyncDispose]: () => handler.close() };

    const insufficientScope = (required: string): Response =>
        Response.json(
            { error: 'insufficient_scope' },
            {
                status: 403,
                headers: {
                    'www-authenticate': `Bearer error="insufficient_scope", scope="${required}", error_description="${required} required for this operation"`
                }
            }
        );

    const gatedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(url, init);
        const auth = request.headers.get('authorization');
        const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
        if (!token) return unauthorized();
        const scopes = TOKEN_SCOPES[token];
        if (scopes === undefined) return unauthorized();
        const mcpName = request.headers.get('mcp-name') ?? undefined;
        const required: string =
            request.headers.get('mcp-method') === 'tools/call' && mcpName ? (REQUIRED_BY_TOOL[mcpName] ?? 'files:read') : 'files:read';
        if (!scopes.includes(required)) return insufficientScope(required);
        return handler.fetch(request, { authInfo: { token, clientId: 'e2e-scoped-caller', scopes } });
    };

    // 1. With the read-only token: list-files reaches the entry; write-file
    //    (modern leg) is rejected at the gate with 403 + insufficient_scope and
    //    the entry is never reached for that request.
    const before = factoryCalls;
    const readClient = new Client({ name: 'scoped-client', version: '1.0.0' });
    if (transport === 'entryModern') readClient.setVersionNegotiation({ mode: { pin: MODERN } });
    await readClient.connect(
        new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
            fetch: gatedFetch,
            requestInit: { headers: { Authorization: 'Bearer read-only-token' } },
            onInsufficientScope: 'throw'
        })
    );
    const listed = await readClient.callTool({ name: 'list-files', arguments: {} });
    expect(listed.content).toEqual([{ type: 'text', text: 'listed by e2e-scoped-caller' }]);
    const reachedAfterList = factoryCalls;
    expect(reachedAfterList).toBeGreaterThan(before);

    if (transport === 'entryModern') {
        const writePromise = readClient.callTool({ name: 'write-file', arguments: {} });
        await expect(writePromise).rejects.toBeInstanceOf(InsufficientScopeError);
        await expect(writePromise).rejects.toMatchObject({ requiredScope: 'files:write' });
        // The 403 came from the gate; no factory call ran for that POST.
        expect(factoryCalls).toBe(reachedAfterList);
    } else {
        // Legacy leg: no Mcp-Name header → the gate's per-operation derivation
        // is not available, so write-file passes the gate (single required scope
        // fallback). The cell pins that the gate composes correctly with the
        // legacy serving path; per-operation enforcement on legacy is host
        // responsibility (e.g., by parsing the body).
        const written = await readClient.callTool({ name: 'write-file', arguments: {} });
        expect(written.content).toEqual([{ type: 'text', text: 'written by e2e-scoped-caller' }]);
    }
    await readClient.close().catch(() => {});

    // 2. With the read-write token: write-file reaches the entry on both legs.
    const rwClient = new Client({ name: 'scoped-client', version: '1.0.0' });
    if (transport === 'entryModern') rwClient.setVersionNegotiation({ mode: { pin: MODERN } });
    await rwClient.connect(
        new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), {
            fetch: gatedFetch,
            requestInit: { headers: { Authorization: 'Bearer read-write-token' } }
        })
    );
    const written = await rwClient.callTool({ name: 'write-file', arguments: {} });
    expect(written.content).toEqual([{ type: 'text', text: 'written by e2e-scoped-caller' }]);
    await rwClient.close().catch(() => {});
});
