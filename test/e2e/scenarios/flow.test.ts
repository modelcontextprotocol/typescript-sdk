/**
 * Self-contained test bodies for composite end-to-end flows.
 *
 * These are longer journeys that combine multiple SDK features: multi-step
 * elicitation, OAuth roundtrip, resumption, session management, proxy
 * forwarding. Each builds whatever in-test pieces it needs (mock AS, minimal
 * EventStore, secondary Clients, proxy McpServer delegating to an upstream
 * Client) rather than importing shared fixtures.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { Client, SdkHttpError, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type {
    ElicitRequest,
    ElicitResult,
    EventStore,
    JSONRPCMessage,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
    Progress
} from '@modelcontextprotocol/server';
import { McpServer, ProtocolErrorCode, Server, specTypeSchemas, UrlElicitationRequiredError } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { hostPerSession, hostResumable, wire } from '../helpers/index';
import { startLegacySseHost } from '../helpers/sse-host';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

verifies('flow:compat:dual-transport-server', async (_args: TestArgs) => {
    // One deployment, one server factory, both transports: the modern Streamable HTTP
    // endpoint and the legacy SSE endpoint serve the same tools to concurrent clients.
    const makeServer = () => {
        const s = new McpServer({ name: 'dual-transport', version: '1.0.0' });
        s.registerTool('add', { inputSchema: z.object({ a: z.number(), b: z.number() }) }, ({ a, b }) => ({
            content: [{ type: 'text', text: String(a + b) }]
        }));
        return s;
    };

    const streamableHost = hostPerSession(makeServer);
    const sseHost = await startLegacySseHost(makeServer);
    try {
        const httpClient = new Client({ name: 'streamable-client', version: '1.0.0' });
        const fetch = (u: URL | string, init?: RequestInit) => streamableHost.handleRequest(new Request(u, init));
        await httpClient.connect(new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch }));

        const sseClient = new Client({ name: 'sse-client', version: '1.0.0' });
        await sseClient.connect(new SSEClientTransport(sseHost.url));

        // Both clients are connected at the same time and reach the same tool surface.
        const [httpResult, sseResult] = await Promise.all([
            httpClient.callTool({ name: 'add', arguments: { a: 1, b: 2 } }),
            sseClient.callTool({ name: 'add', arguments: { a: 3, b: 4 } })
        ]);
        expect(httpResult.content).toEqual([{ type: 'text', text: '3' }]);
        expect(sseResult.content).toEqual([{ type: 'text', text: '7' }]);

        await httpClient.close();
        await sseClient.close();
    } finally {
        await streamableHost.close();
        await sseHost.close();
    }
});

verifies('flow:compat:streamable-then-sse-fallback', async (_args: TestArgs) => {
    // An SSE-only deployment (a pre-Streamable-HTTP server). A client that prefers
    // Streamable HTTP gets a 4xx on initialize and falls back to the legacy SSE
    // client transport against the same URL, per the spec's backwards-compatibility
    // guidance for clients.
    const makeServer = () => {
        const s = new McpServer({ name: 'sse-only', version: '1.0.0' });
        s.registerTool('greet', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'hello' }] }));
        return s;
    };

    const host = await startLegacySseHost(makeServer);
    try {
        // 1. Streamable HTTP attempt: POSTing initialize to the legacy SSE endpoint fails with a 4xx.
        const streamableClient = new Client({ name: 'fallback-client', version: '1.0.0' });
        let rejection: unknown;
        try {
            await streamableClient.connect(new StreamableHTTPClientTransport(host.url));
        } catch (error) {
            rejection = error;
        }
        expect(rejection).toBeInstanceOf(SdkHttpError);
        if (!(rejection instanceof SdkHttpError)) throw new Error('rejection is not an SdkHttpError');
        // 400/404/405 is the signal to fall back to the legacy transport.
        expect([400, 404, 405]).toContain(rejection.status);

        // 2. Fall back to the legacy SSE client transport against the same server.
        const sseClient = new Client({ name: 'fallback-client', version: '1.0.0' });
        await sseClient.connect(new SSEClientTransport(host.url));
        const result = await sseClient.callTool({ name: 'greet', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
        await sseClient.close();
    } finally {
        await host.close();
    }
});

verifies('flow:elicitation:multi-step-form', async ({ transport }: TestArgs) => {
    // Server: tool that issues three sequential elicitation/create requests
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('multi-step', { inputSchema: z.object({}) }, async (_args, ctx) => {
            const step1 = await ctx.mcpReq.send(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
                        message: 'What is your name?',
                        requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
                    }
                },
                specTypeSchemas.ElicitResult
            );
            if (step1.action !== 'accept' || typeof step1.content?.name !== 'string') {
                return { content: [{ type: 'text', text: `aborted at step 1: ${step1.action}` }] };
            }
            const name = step1.content.name;

            const step2 = await ctx.mcpReq.send(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
                        message: `Hello ${name}, what is your favorite color?`,
                        requestedSchema: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] }
                    }
                },
                specTypeSchemas.ElicitResult
            );
            if (step2.action !== 'accept' || typeof step2.content?.color !== 'string') {
                return { content: [{ type: 'text', text: `aborted at step 2: ${step2.action}` }] };
            }
            const color = step2.content.color;

            const step3 = await ctx.mcpReq.send(
                {
                    method: 'elicitation/create',
                    params: {
                        mode: 'form',
                        message: `${name}, you picked ${color}. Confirm?`,
                        requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                    }
                },
                specTypeSchemas.ElicitResult
            );
            if (step3.action !== 'accept') {
                return { content: [{ type: 'text', text: `aborted at step 3: ${step3.action}` }] };
            }

            return { content: [{ type: 'text', text: `${name}'s favorite color is ${color}` }] };
        });
        return s;
    };

    // Client: registers handler for elicitation/create, queues responses
    const received: ElicitRequest[] = [];
    const queued: ElicitResult[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req);
        const resp = queued.shift();
        if (!resp) throw new Error('no queued elicitation response');
        return resp;
    });

    await using _ = await wire(transport, makeServer, client);

    // Happy path: accept all three steps
    queued.push(
        { action: 'accept', content: { name: 'Ada' } },
        { action: 'accept', content: { color: 'blue' } },
        { action: 'accept', content: { confirm: true } }
    );

    const ok = await client.callTool({ name: 'multi-step', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: 'text', text: "Ada's favorite color is blue" }]);

    expect(received).toHaveLength(3);
    const [firstStep, secondStep, thirdStep] = received;
    if (!firstStep || !secondStep || !thirdStep) throw new Error('expected three elicitation requests');
    expect(firstStep.params).toMatchObject({ mode: 'form', requestedSchema: { properties: { name: { type: 'string' } } } });
    expect(secondStep.params.message).toContain('Ada');
    expect(secondStep.params).toMatchObject({ mode: 'form', requestedSchema: { properties: { color: { type: 'string' } } } });
    expect(thirdStep.params.message).toContain('Ada');
    expect(thirdStep.params.message).toContain('blue');
    expect(thirdStep.params).toMatchObject({ mode: 'form', requestedSchema: { properties: { confirm: { type: 'boolean' } } } });

    // Decline at step 2
    queued.push({ action: 'accept', content: { name: 'Bob' } }, { action: 'decline' });
    const declined = await client.callTool({ name: 'multi-step', arguments: {} });
    expect(declined.isError).toBeFalsy();
    expect(declined.content).toEqual([{ type: 'text', text: 'aborted at step 2: decline' }]);
    expect(received).toHaveLength(5);

    // Cancel at step 1
    queued.push({ action: 'cancel' }, { action: 'accept', content: { color: 'red' } }); // sentinel: must not be consumed
    const cancelled = await client.callTool({ name: 'multi-step', arguments: {} });
    expect(cancelled.isError).toBeFalsy();
    expect(cancelled.content).toEqual([{ type: 'text', text: 'aborted at step 1: cancel' }]);
    expect(received).toHaveLength(6);
    expect(queued).toHaveLength(1); // sentinel still queued
});

verifies('flow:elicitation:url-at-session-init', async (_args: TestArgs) => {
    // Not wire(): a transport.send tap must be installed before connect to prove no client request precedes the unsolicited elicitation.
    // Server: issues URL-mode elicitation immediately after onsessioninitialized
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.oninitialized = () => {
            setTimeout(() => {
                void s
                    .elicitInput({
                        mode: 'url',
                        message: 'Authorize the session',
                        url: 'https://example.com/auth',
                        elicitationId: 'session-init-elicit'
                    })
                    .catch(() => {});
            }, 0);
        };
        s.setRequestHandler('tools/list', () => ({ tools: [] }));
        return s;
    };

    const received: ElicitRequest[] = [];
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { url: {} } } });
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req);
        return { action: 'accept' };
    });

    const handle = hostPerSession(makeServer);
    const url = new URL('http://in-process/mcp');
    const customFetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));
    const transport = new StreamableHTTPClientTransport(url, { fetch: customFetch });

    // Tap wire before connecting
    const sent: JSONRPCMessage[] = [];
    const origSend = transport.send.bind(transport);
    transport.send = async (m, opts) => {
        if (Array.isArray(m)) {
            sent.push(...m);
        } else {
            sent.push(m);
        }
        return origSend(m, opts);
    };

    await client.connect(transport);

    try {
        // Wait for the unsolicited server→client elicitation/create
        await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(1));

        expect(received).toHaveLength(1);
        const [initElicitation] = received;
        if (!initElicitation) throw new Error('expected one elicitation request');
        expect(initElicitation.method).toBe('elicitation/create');
        const params = initElicitation.params;
        if (params.mode !== 'url') throw new Error('expected url mode');
        expect(params.elicitationId).toBe('session-init-elicit');
        expect(() => new URL(params.url)).not.toThrow();

        // Client has only sent initialize so far (no post-init requests)
        const requests = sent.filter(m => 'method' in m && 'id' in m);
        expect(requests.map(r => r.method)).toEqual(['initialize']);

        // Session survived
        await expect(client.ping()).resolves.toBeDefined();
    } finally {
        await Promise.all([client.close(), handle.close()]);
    }
});

verifies('flow:elicitation:url-required-then-retry', async ({ transport }: TestArgs) => {
    // Server: tool that throws UrlElicitationRequiredError until elicitation is completed
    const completed = new Set<string>();
    let server: McpServer | undefined;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('url-gated', { inputSchema: z.object({}) }, () => {
            const elicitationId = 'url-elicit-1';
            if (!completed.has(elicitationId)) {
                throw new UrlElicitationRequiredError([
                    {
                        mode: 'url',
                        message: 'Please sign in',
                        elicitationId,
                        url: 'https://example.com/auth'
                    }
                ]);
            }
            return { content: [{ type: 'text', text: 'authenticated' }] };
        });
        server = s;
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { url: {} } } });
    const completionsSeen: string[] = [];
    client.setNotificationHandler('notifications/elicitation/complete', async n => {
        completionsSeen.push(n.params.elicitationId);
    });
    await using _ = await wire(transport, makeServer, client);

    // Step 1: first call rejects with UrlElicitationRequiredError
    const err = await client.callTool({ name: 'url-gated', arguments: {} }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UrlElicitationRequiredError);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error('expected UrlElicitationRequiredError');
    expect(err.code).toBe(ProtocolErrorCode.UrlElicitationRequired);
    expect(err.elicitations).toHaveLength(1);
    const [elicitation] = err.elicitations;
    if (!elicitation) throw new Error('expected one required elicitation');
    expect(elicitation.mode).toBe('url');
    expect(typeof elicitation.elicitationId).toBe('string');
    expect(elicitation.url).toMatch(/^https?:\/\//);

    // Step 2: user "opens" the URL (out-of-band, simulated by marking complete)
    completed.add(elicitation.elicitationId);

    // Step 3: server emits notifications/elicitation/complete and the client receives it for that exact elicitation
    if (!server) throw new Error('makeServer was never invoked');
    await server.server.createElicitationCompletionNotifier(elicitation.elicitationId)();
    await vi.waitFor(() => expect(completionsSeen).toEqual([elicitation.elicitationId]));

    // Step 4: retry succeeds
    const result = await client.callTool({ name: 'url-gated', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'authenticated' }]);
});

verifies('flow:multi-client:stateful-isolation', async (_args: TestArgs) => {
    // Not wire(): three clients share one host and the test reads each transport's sessionId; wire() binds a single client to its own host.
    // Server: per-session McpServer with progress tool
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps, message: `step ${i}/${steps}` }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done after ${steps} steps` }] };
        });
        return s;
    };

    // Three clients connect to the same per-session host, each with distinct step counts
    const handle = hostPerSession(makeServer);
    const url = new URL('http://in-process/mcp');
    const customFetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    interface SessionUnderTest {
        client: Client;
        transport: StreamableHTTPClientTransport;
        steps: number;
        errors: Error[];
    }
    const sessions: SessionUnderTest[] = [
        { name: 'a', steps: 2 },
        { name: 'b', steps: 3 },
        { name: 'c', steps: 4 }
    ].map(({ name, steps }) => ({
        client: new Client({ name, version: '0' }),
        transport: new StreamableHTTPClientTransport(url, { fetch: customFetch }),
        steps,
        errors: []
    }));

    try {
        for (const session of sessions) {
            session.client.onerror = error => session.errors.push(error);
            await session.client.connect(session.transport);
        }

        const sessionIds = sessions.map(s => s.transport.sessionId);
        for (const id of sessionIds) {
            expect(id).toEqual(expect.any(String));
        }
        expect(new Set(sessionIds).size).toBe(3);

        // Concurrent progress calls with distinct step counts
        const runs = await Promise.all(
            sessions.map(async ({ client, steps }) => {
                const received: Progress[] = [];
                const result = await client.callTool(
                    { name: 'progress', arguments: { steps } },
                    { onprogress: p => received.push({ progress: p.progress, total: p.total, message: p.message }) }
                );
                return { steps, received, result };
            })
        );

        for (const { steps, received, result } of runs) {
            expect(received).toEqual(
                Array.from({ length: steps }, (_, k) => ({
                    progress: k + 1,
                    total: steps,
                    message: `step ${k + 1}/${steps}`
                }))
            );
            expect(result.content).toEqual([{ type: 'text', text: `done after ${steps} steps` }]);
        }

        for (const session of sessions) {
            expect(session.errors).toEqual([]);
        }
    } finally {
        await Promise.all([...sessions.map(s => s.client.close()), handle.close()]);
    }
});

verifies('flow:oauth:authorization-code-roundtrip', async (_args: TestArgs) => {
    // Not wire(): needs an authProvider-equipped client transport plus 401/PRM/AS fetch routing in front of the host, which wire() does not expose.
    const ACCESS_TOKEN = 'roundtrip-access-token';
    const AUTH_CODE = 'granted-authorization-code';
    const AS_ORIGIN = 'https://as.example.com';
    const PRM_PATH = '/.well-known/oauth-protected-resource';

    // Mock Authorization Server: metadata discovery, dynamic client registration, code exchange.
    const registerRequests: Array<Record<string, unknown>> = [];
    const tokenRequests: URLSearchParams[] = [];
    const mockASFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const req = new Request(url, init);
        const u = new URL(req.url);
        if (u.pathname === '/.well-known/oauth-authorization-server') {
            return Response.json(
                {
                    issuer: AS_ORIGIN,
                    authorization_endpoint: `${AS_ORIGIN}/authorize`,
                    token_endpoint: `${AS_ORIGIN}/token`,
                    registration_endpoint: `${AS_ORIGIN}/register`,
                    grant_types_supported: ['authorization_code'],
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                },
                { status: 200 }
            );
        }
        if (u.pathname === '/register' && req.method === 'POST') {
            const body = z.record(z.string(), z.unknown()).parse(await req.json());
            registerRequests.push(body);
            // RFC 7591: the registration response echoes the submitted metadata plus the issued client_id.
            return Response.json({ ...body, client_id: 'mock-client-id' }, { status: 201 });
        }
        if (u.pathname === '/token' && req.method === 'POST') {
            tokenRequests.push(new URLSearchParams(await req.text()));
            return Response.json({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 }, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
    };

    // Mock OAuthClientProvider
    const redirectedTo: string[] = [];
    const saved: { tokens?: OAuthTokens; clientInfo?: OAuthClientInformationMixed; codeVerifier?: string } = {};
    const provider: OAuthClientProvider = {
        get redirectUrl() {
            return 'http://localhost/callback';
        },
        get clientMetadata(): OAuthClientMetadata {
            return {
                client_name: 'test-client',
                client_uri: 'http://localhost',
                redirect_uris: ['http://localhost/callback']
            };
        },
        clientInformation: () => saved.clientInfo,
        saveClientInformation: async ci => {
            saved.clientInfo = ci;
        },
        tokens: () => saved.tokens,
        saveTokens: async t => {
            saved.tokens = t;
        },
        codeVerifier: () => {
            if (!saved.codeVerifier) throw new Error('No code verifier saved');
            return saved.codeVerifier;
        },
        saveCodeVerifier: async v => {
            saved.codeVerifier = v;
        },
        redirectToAuthorization: async url => {
            redirectedTo.push(url.toString());
        }
    };

    // Server with bearer auth
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };

    // Protected host: serves RFC 9728 resource metadata, otherwise requires the issued bearer token.
    const handle = hostPerSession(makeServer);
    const url = new URL('http://in-process/mcp');
    const serverFetch = async (u: URL | string, init?: RequestInit): Promise<Response> => {
        const req = new Request(u, init);
        const requestUrl = new URL(req.url);
        if (requestUrl.pathname.startsWith(PRM_PATH)) {
            return Response.json({ resource: url.toString(), authorization_servers: [AS_ORIGIN] }, { status: 200 });
        }
        const auth = req.headers.get('authorization');
        if (auth !== `Bearer ${ACCESS_TOKEN}`) {
            return new Response(null, {
                status: 401,
                headers: { 'WWW-Authenticate': `Bearer resource_metadata="http://in-process${PRM_PATH}/mcp"` }
            });
        }
        return handle.handleRequest(req);
    };

    const combinedFetch = async (u: URL | string, init?: RequestInit): Promise<Response> => {
        const requestUrl = typeof u === 'string' ? new URL(u) : u;
        if (requestUrl.hostname === 'as.example.com') return mockASFetch(requestUrl, init);
        return serverFetch(requestUrl, init);
    };

    const client = new Client({ name: 'c', version: '0' });

    try {
        // Step 1: first connect fails with 401 → discovery + DCR + redirect to the authorization endpoint
        const transport1 = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: combinedFetch });
        await expect(client.connect(transport1)).rejects.toBeInstanceOf(UnauthorizedError);

        expect(redirectedTo).toHaveLength(1);
        const [authorizationRedirect] = redirectedTo;
        if (!authorizationRedirect) throw new Error('expected a redirect to the authorization endpoint');
        const authorizeUrl = new URL(authorizationRedirect);
        expect(authorizeUrl.origin).toBe(AS_ORIGIN);
        expect(authorizeUrl.pathname).toBe('/authorize');
        expect(authorizeUrl.searchParams.get('client_id')).toBe('mock-client-id');
        expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
        expect(registerRequests).toHaveLength(1);
        expect(saved.tokens).toBeUndefined();

        const codeVerifier = saved.codeVerifier;
        if (!codeVerifier) throw new Error('No code verifier saved during the redirect step');

        // Step 2: user completes redirect, finishAuth exchanges the code for tokens
        await transport1.finishAuth(AUTH_CODE);

        expect(tokenRequests).toHaveLength(1);
        const [tokenRequest] = tokenRequests;
        if (!tokenRequest) throw new Error('expected one token request');
        expect(tokenRequest.get('grant_type')).toBe('authorization_code');
        expect(tokenRequest.get('code')).toBe(AUTH_CODE);
        expect(tokenRequest.get('code_verifier')).toBe(codeVerifier);
        expect(tokenRequest.get('redirect_uri')).toBe('http://localhost/callback');
        expect(saved.tokens?.access_token).toBe(ACCESS_TOKEN);

        // Step 3: second connect with fresh transport succeeds and tools/list works
        const transport2 = new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: combinedFetch });
        await client.connect(transport2);

        const { tools } = await client.listTools();
        expect(tools.some(t => t.name === 'echo')).toBe(true);
    } finally {
        await Promise.all([client.close(), handle.close()]);
    }
});

verifies('flow:resume:tool-call-resumption-token', async (_args: TestArgs) => {
    // Not wire(): needs an EventStore-backed host and a severable fetch to simulate a mid-stream disconnect, which wire() does not expose.
    const TOTAL_STEPS = 4;
    const DELIVERED_BEFORE_DISCONNECT = 2;

    // The tool pauses after the first two progress notifications so the test can sever the call's SSE
    // stream before the remaining notifications and the result are produced.
    let releaseRemainingSteps: () => void = () => {
        throw new Error('remainingStepsReleased resolver not captured yet');
    };
    const remainingStepsReleased = new Promise<void>(resolve => {
        releaseRemainingSteps = resolve;
    });
    let toolRuns = 0;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('import-records', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, ctx) => {
            toolRuns++;
            const token = ctx.mcpReq._meta?.progressToken;
            if (token === undefined) throw new Error('import-records expects a progressToken');
            for (let i = 1; i <= steps; i++) {
                if (i === DELIVERED_BEFORE_DISCONNECT + 1) {
                    await remainingStepsReleased;
                }
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: i, total: steps }
                });
            }
            return { content: [{ type: 'text', text: `imported ${steps} record batches` }] };
        });
        return s;
    };

    // Insertion-ordered EventStore: replay order (and therefore the exact-sequence assertions below) must not depend on timestamps.
    const storedEvents: Array<{ eventId: string; streamId: string; message: JSONRPCMessage }> = [];
    const eventStore: EventStore = {
        storeEvent: async (streamId, message) => {
            const eventId = `${streamId}|${storedEvents.length + 1}`;
            storedEvents.push({ eventId, streamId, message });
            return eventId;
        },
        replayEventsAfter: async (lastEventId, { send }) => {
            const lastIndex = storedEvents.findIndex(e => e.eventId === lastEventId);
            const lastEvent = storedEvents[lastIndex];
            if (!lastEvent) return '';
            const { streamId } = lastEvent;
            for (const event of storedEvents.slice(lastIndex + 1)) {
                if (event.streamId === streamId) await send(event.eventId, event.message);
            }
            return streamId;
        }
    };

    const handle = hostResumable(makeServer, { eventStore, retryInterval: 0 });
    const url = new URL('http://in-process/mcp');

    const requests: Array<{ method: string; lastEventId: string | undefined; sessionId: string | undefined; body: string | undefined }> =
        [];

    // The tools/call response is wrapped so the test can sever the stream the client is reading (a simulated
    // network drop); the server keeps writing the rest of the stream, which only the EventStore retains.
    let severToolCallStream: () => void = () => {
        throw new Error('tools/call SSE stream not opened yet');
    };
    let originalStreamFinished: () => void = () => {
        throw new Error('originalStreamComplete resolver not captured yet');
    };
    const originalStreamComplete = new Promise<void>(resolve => {
        originalStreamFinished = resolve;
    });

    const customFetch = async (u: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(u, init);
        const lastEventId = request.headers.get('last-event-id') ?? undefined;
        const body = typeof init?.body === 'string' ? init.body : undefined;
        requests.push({ method: request.method, lastEventId, sessionId: request.headers.get('mcp-session-id') ?? undefined, body });

        // Hold the transport's recovery GET until the server has finished the interrupted stream, so the
        // replay deterministically contains every message the client missed.
        if (request.method === 'GET' && lastEventId !== undefined) {
            await originalStreamComplete;
        }

        const response = await handle.handleRequest(request);
        if (request.method !== 'POST' || !body?.includes('"tools/call"') || !response.body) {
            return response;
        }

        const upstream = response.body.getReader();
        let severed = false;
        const severable = new ReadableStream<Uint8Array>({
            start: controller => {
                severToolCallStream = () => {
                    severed = true;
                    controller.error(new Error('simulated mid-stream network drop'));
                };
                void (async () => {
                    while (true) {
                        const { value, done } = await upstream.read();
                        if (done) break;
                        if (!severed && value) controller.enqueue(value);
                    }
                    originalStreamFinished();
                    if (!severed) controller.close();
                })();
            }
        });
        return new Response(severable, { status: response.status, headers: response.headers });
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(url, {
        fetch: customFetch,
        reconnectionOptions: { initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 2 }
    });
    await client.connect(transport);

    try {
        const progressSeen: number[] = [];
        const eventIdsSeen: string[] = [];
        const callSettled = vi.fn();

        // The one and only tools/call of this test: this same promise must resolve after the disconnect.
        const call = client.callTool(
            { name: 'import-records', arguments: { steps: TOTAL_STEPS } },
            {
                onprogress: (p: Progress) => progressSeen.push(p.progress),
                onresumptiontoken: id => eventIdsSeen.push(id)
            }
        );
        call.then(callSettled, callSettled);

        await vi.waitFor(() => expect(progressSeen).toEqual([1, 2]));
        const lastEventIdBeforeDisconnect = eventIdsSeen.at(-1);

        // Sever mid-call, then let the server finish steps 3..4 and the result while the client is disconnected.
        severToolCallStream();
        expect(callSettled).not.toHaveBeenCalled();
        releaseRemainingSteps();
        await originalStreamComplete;
        expect(progressSeen).toEqual([1, 2]);
        expect(callSettled).not.toHaveBeenCalled();

        // The original promise resolves with the tool's result; the handler ran exactly once.
        const result = await call;
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: `imported ${TOTAL_STEPS} record batches` }]);
        expect(toolRuns).toBe(1);

        // Recovery delivered only the missed notifications: no duplicates, none missing.
        expect(progressSeen).toEqual([1, 2, 3, 4]);

        const lastEventBeforeDisconnect = storedEvents.find(e => e.eventId === lastEventIdBeforeDisconnect);
        if (!lastEventBeforeDisconnect) throw new Error('the last event id delivered before the disconnect was never stored');
        const toolCallStreamEvents = storedEvents.filter(e => e.streamId === lastEventBeforeDisconnect.streamId);

        // The whole stream was persisted (priming placeholder, four progress notifications, result), and the
        // client saw each of its events exactly once, in order, across the original stream and the replay.
        expect(
            toolCallStreamEvents.map(e => ('method' in e.message ? e.message.method : 'result' in e.message ? 'response' : 'priming'))
        ).toEqual([
            'priming',
            'notifications/progress',
            'notifications/progress',
            'notifications/progress',
            'notifications/progress',
            'response'
        ]);
        expect(eventIdsSeen).toEqual(toolCallStreamEvents.map(e => e.eventId));
        // Index DELIVERED_BEFORE_DISCONNECT skips the priming event, landing on the second progress notification.
        const expectedLastDeliveredEvent = toolCallStreamEvents[DELIVERED_BEFORE_DISCONNECT];
        if (!expectedLastDeliveredEvent) throw new Error('the tool-call stream did not retain the second progress notification');
        expect(lastEventIdBeforeDisconnect).toBe(expectedLastDeliveredEvent.eventId);

        // Transparency: the caller never re-issued the call; the transport recovered with a single GET
        // carrying Last-Event-ID for the last event delivered before the disconnect, on the same session.
        expect(requests.filter(r => r.method === 'POST' && r.body?.includes('"tools/call"'))).toHaveLength(1);
        const recoveryGets = requests.filter(r => r.method === 'GET' && r.lastEventId !== undefined);
        expect(recoveryGets).toHaveLength(1);
        const [recoveryGet] = recoveryGets;
        if (!recoveryGet) throw new Error('expected one recovery GET');
        expect(recoveryGet.lastEventId).toBe(lastEventIdBeforeDisconnect);
        expect(transport.sessionId).toEqual(expect.any(String));
        expect(recoveryGet.sessionId).toBe(transport.sessionId);
    } finally {
        await Promise.all([client.close(), handle.close()]);
    }
});

verifies('flow:session:terminate-then-reconnect', async (_args: TestArgs) => {
    // Not wire(): drives StreamableHTTPClientTransport directly for sessionId/terminateSession() and connects a second transport to the same host.
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    };

    const handle = hostPerSession(makeServer);
    const url = new URL('http://in-process/mcp');
    const customFetch = (u: URL | string, init?: RequestInit) => handle.handleRequest(new Request(u, init));

    const client1 = new Client({ name: 'c', version: '0' });
    const transport1 = new StreamableHTTPClientTransport(url, { fetch: customFetch });
    await client1.connect(transport1);

    try {
        const originalSessionId = transport1.sessionId;
        expect(originalSessionId).toEqual(expect.any(String));

        // Terminate session
        await transport1.terminateSession();
        expect(transport1.sessionId).toBeUndefined();

        // Close first client
        await client1.close();

        // Fresh client and transport obtain new session
        const client2 = new Client({ name: 'c', version: '0' });
        const transport2 = new StreamableHTTPClientTransport(url, { fetch: customFetch });
        await client2.connect(transport2);

        const newSessionId = transport2.sessionId;
        expect(newSessionId).toEqual(expect.any(String));
        expect(newSessionId).not.toBe(originalSessionId);

        // Operations succeed on new session
        const result = await client2.callTool({ name: 'echo', arguments: { text: 'after-reconnect' } });
        expect(result.isError).toBeFalsy();
        expect(result.content).toEqual([{ type: 'text', text: 'after-reconnect' }]);

        await client2.close();
    } finally {
        await handle.close();
    }
});

verifies('flow:tool-result:resource-link-follow', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('resource-link', { inputSchema: z.object({}) }, () => ({
            content: [
                {
                    type: 'resource_link',
                    uri: 'file:///linked.txt',
                    name: 'linked.txt',
                    mimeType: 'text/plain'
                }
            ]
        }));
        s.registerResource('linked.txt', 'file:///linked.txt', { mimeType: 'text/plain' }, async () => ({
            contents: [{ uri: 'file:///linked.txt', mimeType: 'text/plain', text: 'linked resource contents' }]
        }));
        return s;
    };

    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, makeServer, client);

    // Call tool and get resource_link
    const toolResult = await client.callTool({ name: 'resource-link', arguments: {} });
    expect(toolResult.isError).toBeFalsy();

    const link = toolResult.content.find(c => c.type === 'resource_link');
    expect(link).toBeDefined();
    if (link?.type !== 'resource_link') throw new Error('unreachable');
    expect(link.uri).toBe('file:///linked.txt');

    // Follow the link with resources/read
    const readResult = await client.readResource({ uri: link.uri });
    expect(readResult.contents).toHaveLength(1);
    const [entry] = readResult.contents;
    if (!entry) throw new Error('expected one resource contents entry');
    expect(entry.uri).toBe(link.uri);
    expect(entry.mimeType).toBe('text/plain');
    if (entry.mimeType?.startsWith('text/')) {
        expect('text' in entry ? entry.text : '').toBe('linked resource contents');
    }
});

verifies('flow:proxy:forward-tools-resources', async ({ transport }: TestArgs) => {
    // Upstream server with tools and resources
    const upstreamServer = new McpServer({ name: 'upstream', version: '0' });
    upstreamServer.registerTool('echo', { description: 'Echoes text', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    upstreamServer.registerTool(
        'annotated',
        {
            description: 'Annotated tool',
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true, idempotentHint: true },
            _meta: { 'example.com/fixture': true }
        },
        () => ({ content: [] })
    );
    upstreamServer.registerResource(
        'annotated',
        'file:///annotated.md',
        {
            mimeType: 'text/markdown',
            _meta: { 'example.com/fixture': true }
        },
        async () => ({
            contents: [{ uri: 'file:///annotated.md', mimeType: 'text/markdown', text: '# Annotated' }]
        })
    );

    // Proxy: low-level Server downstream + Client upstream
    const upstreamClient = new Client({ name: 'proxy-upstream', version: '0' });
    const proxyServer = new Server({ name: 'proxy', version: '0' }, { capabilities: { tools: {}, resources: {} } });

    proxyServer.setRequestHandler('tools/list', async req => {
        const result = await upstreamClient.listTools(req.params);
        return { tools: result.tools, nextCursor: result.nextCursor };
    });
    proxyServer.setRequestHandler('resources/list', async req => {
        const result = await upstreamClient.listResources(req.params);
        return { resources: result.resources, nextCursor: result.nextCursor };
    });
    proxyServer.setRequestHandler('resources/read', async req => {
        return upstreamClient.readResource(req.params);
    });

    // Wire: downstream client → proxy server → upstream client → upstream server
    const downstreamClient = new Client({ name: 'downstream', version: '0' });

    // Two wires must stay open for the whole body; explicit dispose in finally instead of two `await using` bindings.
    const upstreamWired = await wire(transport, () => upstreamServer, upstreamClient);
    try {
        const proxyWired = await wire(transport, () => proxyServer, downstreamClient);
        try {
            // Downstream sees upstream tools
            const { tools } = await downstreamClient.listTools();
            const echo = tools.find(t => t.name === 'echo');
            expect(echo).toBeDefined();
            if (!echo) throw new Error('unreachable');
            expect(echo.description).toBe('Echoes text');
            expect(echo.inputSchema.properties).toMatchObject({ text: { type: 'string' } });

            const annotatedTool = tools.find(t => t.name === 'annotated');
            expect(annotatedTool).toBeDefined();
            if (!annotatedTool) throw new Error('unreachable');
            expect(annotatedTool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
            expect(annotatedTool._meta).toEqual({ 'example.com/fixture': true });

            // Downstream sees upstream resources
            const { resources } = await downstreamClient.listResources();
            const annotatedRes = resources.find(r => r.uri === 'file:///annotated.md');
            expect(annotatedRes).toBeDefined();
            if (!annotatedRes) throw new Error('unreachable');
            expect(annotatedRes.name).toBe('annotated');
            expect(annotatedRes._meta).toEqual({ 'example.com/fixture': true });
        } finally {
            await proxyWired[Symbol.asyncDispose]();
        }
    } finally {
        await upstreamWired[Symbol.asyncDispose]();
    }
});
