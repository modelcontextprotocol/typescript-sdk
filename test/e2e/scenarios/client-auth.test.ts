/**
 * Self-contained test bodies for the client-auth surface (OAuth client flows + middleware).
 *
 * All tests use streamableHttp transport. A reusable mock Authorization Server
 * (routing function) handles discovery, DCR, and token exchange; a recording
 * OAuthClientProvider tracks state transitions and SDK calls.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import type { AuthProvider, OAuthClientProvider } from '@modelcontextprotocol/client';
import {
    applyMiddlewares,
    auth,
    Client,
    ClientCredentialsProvider,
    computeScopeUnion,
    createMiddleware,
    discoverAuthorizationServerMetadata,
    discoverOAuthProtectedResourceMetadata,
    exchangeAuthorization,
    InsecureTokenEndpointError,
    InsufficientScopeError,
    isStrictScopeSuperset,
    IssuerMismatchError,
    OAuthError,
    OAuthErrorCode,
    PrivateKeyJwtProvider,
    refreshAuthorization,
    registerClient,
    RegistrationRejectedError,
    resolveClientMetadata,
    SdkError,
    SSEClientTransport,
    SseError,
    startAuthorization,
    StaticPrivateKeyJwtProvider,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    validateAuthorizationResponseIssuer,
    withLogging,
    withOAuth
} from '@modelcontextprotocol/client';
import type {
    AuthorizationServerMetadata,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from '@modelcontextprotocol/server';
import { LATEST_PROTOCOL_VERSION, McpServer } from '@modelcontextprotocol/server';
import { importSPKI, jwtVerify } from 'jose';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { hostPerSession } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const ISSUER = 'https://auth.example.com';
const MCP_URL = 'http://in-process/mcp';
const RESOURCE = 'http://in-process/mcp';

// Narrows indexed-access results that the surrounding count assertions have already proven to exist.
function defined<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`Expected ${label} to be defined`);
    return value;
}

interface MockASConfig {
    tokenResponses?: Array<Partial<OAuthTokens>>;
    tokenErrorResponses?: Array<{ error: string; error_description?: string }>;
    registerResponse?: Partial<OAuthClientInformationFull>;
    registerErrorResponse?: { status: number; error: string; error_description?: string };
    asMetadata?: Partial<AuthorizationServerMetadata>;
    prmMetadata?: Record<string, unknown>;
    noPRMDiscovery?: boolean;
    noASDiscovery?: boolean;
    refusePKCE?: boolean;
    resourceMismatch?: boolean;
}

function createMockAuthorizationServer(config: MockASConfig = {}) {
    const tokenCalls: Array<{ method: string; headers: Record<string, string>; body: URLSearchParams }> = [];
    const authorizeCalls: Array<{ url: URL; params: URLSearchParams }> = [];
    const registerCalls: Array<{ body: Record<string, unknown> }> = [];
    const discoveryCalls: string[] = [];

    let tokenIndex = 0;
    let tokenErrorIndex = 0;

    const asMetadata: AuthorizationServerMetadata = {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        response_types_supported: ['code'],
        registration_endpoint: `${ISSUER}/register`,
        code_challenge_methods_supported: config.refusePKCE ? ['plain'] : ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        ...config.asMetadata
    };

    const prmMetadata = {
        resource: config.resourceMismatch ? 'https://wrong.example.com' : RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['mcp:read', 'mcp:write'],
        ...config.prmMetadata
    };

    const handleRequest = async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path.includes('/.well-known/oauth-protected-resource')) {
            discoveryCalls.push(path);
            if (config.noPRMDiscovery) {
                return new Response('Not Found', { status: 404 });
            }
            return Response.json(prmMetadata, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (path.includes('/.well-known/oauth-authorization-server') || path.includes('/.well-known/openid-configuration')) {
            discoveryCalls.push(path);
            if (config.noASDiscovery) {
                return new Response('Not Found', { status: 404 });
            }
            return Response.json(asMetadata, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (path === '/authorize') {
            authorizeCalls.push({ url, params: new URLSearchParams(url.search) });
            return new Response('Authorization page', { status: 200 });
        }

        if (path === '/token' && req.method === 'POST') {
            const bodyText = await req.text();
            const body = new URLSearchParams(bodyText);
            const headers: Record<string, string> = {};
            for (const [k, v] of req.headers.entries()) {
                headers[k] = v;
            }
            tokenCalls.push({ method: req.method, headers, body });

            if (config.tokenErrorResponses && tokenErrorIndex < config.tokenErrorResponses.length) {
                const err = config.tokenErrorResponses[tokenErrorIndex++];
                return Response.json(err, {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const response = config.tokenResponses?.[tokenIndex++] ?? { access_token: 'mock-token', token_type: 'Bearer' };
            return Response.json(response, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (path === '/register' && req.method === 'POST') {
            const body = z.record(z.string(), z.unknown()).parse(await req.json());
            registerCalls.push({ body });
            if (config.registerErrorResponse) {
                const { status, ...err } = config.registerErrorResponse;
                return Response.json(err, { status, headers: { 'Content-Type': 'application/json' } });
            }
            // RFC 7591: the registration response echoes the submitted metadata plus issued credentials.
            const response = {
                ...body,
                client_id: 'registered-client-id',
                client_secret: 'registered-client-secret',
                token_endpoint_auth_method: 'client_secret_basic',
                ...config.registerResponse
            };
            return Response.json(response, {
                status: 201,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not Found', { status: 404 });
    };

    return { handleRequest, tokenCalls, authorizeCalls, registerCalls, discoveryCalls };
}

class RecordingOAuthClientProvider implements OAuthClientProvider {
    redirectedTo: URL[] = [];
    invalidatedCredentials: Array<'tokens' | 'all'> = [];
    saved: {
        tokens?: OAuthTokens;
        clientInformation?: OAuthClientInformationMixed;
        codeVerifier?: string;
        state?: string;
    } = {};

    constructor(
        private readonly initial: {
            tokens?: OAuthTokens;
            clientInformation?: OAuthClientInformationMixed;
            clientMetadataUrl?: string;
            clientMetadata?: Partial<OAuthClientMetadata>;
        } = {}
    ) {
        if (initial.tokens) this.saved.tokens = initial.tokens;
        if (initial.clientInformation) this.saved.clientInformation = initial.clientInformation;
    }

    get redirectUrl() {
        return 'http://localhost:3000/callback';
    }

    get clientMetadataUrl() {
        return this.initial.clientMetadataUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: 'Test Client',
            redirect_uris: [this.redirectUrl],
            ...this.initial.clientMetadata
        };
    }

    state() {
        this.saved.state = `state-${Date.now()}`;
        return this.saved.state;
    }

    clientInformation() {
        return this.saved.clientInformation;
    }

    saveClientInformation(info: OAuthClientInformationMixed) {
        this.saved.clientInformation = info;
    }

    tokens() {
        return this.saved.tokens;
    }

    saveTokens(tokens: OAuthTokens) {
        this.saved.tokens = tokens;
    }

    redirectToAuthorization(url: URL) {
        this.redirectedTo.push(url);
    }

    saveCodeVerifier(verifier: string) {
        this.saved.codeVerifier = verifier;
    }

    codeVerifier() {
        if (!this.saved.codeVerifier) throw new Error('No code verifier saved');
        return this.saved.codeVerifier;
    }

    invalidateCredentials(what: 'tokens' | 'all') {
        this.invalidatedCredentials.push(what);
        if (what === 'tokens') {
            delete this.saved.tokens;
        } else {
            this.saved = {};
        }
    }
}

function createAuthenticatedHost(validToken: string) {
    return hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, (_args, ctx) => {
            if (ctx.http?.authInfo?.token !== validToken) {
                throw new Error('Invalid token');
            }
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    });
}

function createCombinedFetch(params: {
    as: ReturnType<typeof createMockAuthorizationServer>;
    mcpHost: ReturnType<typeof createAuthenticatedHost>;
    validToken?: string;
    requireAuth?: boolean;
}) {
    const { as, mcpHost, validToken, requireAuth = true } = params;
    return async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return as.handleRequest(new Request(url, init));
        }
        if (requireAuth) {
            const h = new Headers(init?.headers);
            if (!h.has('authorization')) {
                return new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"` }
                });
            }
            if (validToken && h.get('authorization') !== `Bearer ${validToken}`) {
                return new Response(null, { status: 401 });
            }
        }
        return mcpHost.handleRequest(new Request(url, init));
    };
}

verifies('client-auth:401-triggers-flow', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer();
    const provider = new RecordingOAuthClientProvider();
    const validToken = 'flow-token';
    const mcpHost = createAuthenticatedHost(validToken);
    const baseFetch = createCombinedFetch({ as, mcpHost, validToken });

    const mcpPosts: string[] = [];
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin !== ISSUER && !urlObj.pathname.includes('/.well-known/') && init?.method === 'POST') {
            mcpPosts.push(urlObj.pathname);
        }
        return baseFetch(url, init);
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // Flow ran exactly once: a single 401'd POST, a single redirect to the authorization endpoint.
        expect(mcpPosts).toHaveLength(1);
        expect(provider.redirectedTo).toHaveLength(1);
        const redirect = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(redirect.origin).toBe(ISSUER);
        expect(redirect.pathname).toBe('/authorize');
        expect(provider.saved.codeVerifier).toBeDefined();

        expect(as.discoveryCalls.some(p => p.includes('/.well-known/oauth-protected-resource'))).toBe(true);
        expect(as.discoveryCalls).toContain('/.well-known/oauth-authorization-server');
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:401-after-auth-throws', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: 'refreshed-access-token', token_type: 'Bearer' }]
    });
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'stale-access-token', token_type: 'Bearer', refresh_token: 'stale-refresh-token' },
        clientInformation: { client_id: 'pre-registered-client' }
    });

    const mcpPosts: string[] = [];
    // The protected resource keeps rejecting with 401 even after the auth flow refreshes the token.
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return as.handleRequest(new Request(url, init));
        }
        if (init?.method === 'POST') {
            mcpPosts.push(urlObj.pathname);
        }
        return new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"` }
        });
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        const connectPromise = client.connect(transport);
        await expect(connectPromise).rejects.toBeInstanceOf(SdkError);
        await expect(connectPromise).rejects.toThrow(/Server returned 401 after re-authentication/);

        // Auth ran exactly once (refresh grant), and the transport stopped after one retry instead of looping.
        expect(as.tokenCalls).toHaveLength(1);
        const refreshCall = defined(as.tokenCalls[0], 'token call');
        expect(refreshCall.body.get('grant_type')).toBe('refresh_token');
        expect(refreshCall.body.get('refresh_token')).toBe('stale-refresh-token');
        expect(mcpPosts).toHaveLength(2);
        expect(provider.redirectedTo).toHaveLength(0);
    } finally {
        await client.close();
    }
});

verifies('client-auth:403-scope-upgrade', async (_args: TestArgs) => {
    const UPGRADED_SCOPE = 'mcp:read mcp:write mcp:admin';
    const insufficientScopeHeader = `Bearer error="insufficient_scope", scope="${UPGRADED_SCOPE}", resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"`;

    // Phase 1: 403 with insufficient_scope triggers a fresh auth attempt requesting the broader scope.
    const interactiveAs = createMockAuthorizationServer();
    const interactiveProvider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'narrow-scope-token', token_type: 'Bearer' },
        clientInformation: { client_id: 'pre-registered-client' }
    });

    const interactiveMcpRequests: string[] = [];
    const interactiveFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return interactiveAs.handleRequest(new Request(url, init));
        }
        interactiveMcpRequests.push(urlObj.pathname);
        return new Response(null, { status: 403, headers: { 'WWW-Authenticate': insufficientScopeHeader } });
    };

    const interactiveClient = new Client({ name: 'c', version: '0' });
    const interactiveTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: interactiveProvider,
        fetch: interactiveFetch
    });

    try {
        await expect(interactiveClient.connect(interactiveTransport)).rejects.toThrow(UnauthorizedError);

        expect(interactiveProvider.redirectedTo).toHaveLength(1);
        const upgradeRedirect = defined(interactiveProvider.redirectedTo[0], 'authorization redirect URL');
        expect(upgradeRedirect.searchParams.get('scope')).toBe(UPGRADED_SCOPE);
        expect(interactiveMcpRequests).toHaveLength(1);
    } finally {
        await interactiveClient.close();
    }

    // Phase 2: when the upscoped token is still rejected, the transport stops at the per-send retry cap instead of looping.
    // The token here already covers the challenged scope, so refresh (not a fresh authorization) is used.
    const refreshAs = createMockAuthorizationServer({
        tokenResponses: [{ access_token: 'upscoped-access-token', token_type: 'Bearer', scope: UPGRADED_SCOPE }]
    });
    const refreshProvider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'narrow-scope-token', token_type: 'Bearer', refresh_token: 'narrow-refresh-token', scope: UPGRADED_SCOPE },
        clientInformation: { client_id: 'pre-registered-client' }
    });

    const refreshMcpRequests: string[] = [];
    const refreshFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return refreshAs.handleRequest(new Request(url, init));
        }
        refreshMcpRequests.push(urlObj.pathname);
        return new Response(null, { status: 403, headers: { 'WWW-Authenticate': insufficientScopeHeader } });
    };

    const refreshClient = new Client({ name: 'c', version: '0' });
    const refreshTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: refreshProvider,
        fetch: refreshFetch
    });

    try {
        const connectPromise = refreshClient.connect(refreshTransport);
        await expect(connectPromise).rejects.toBeInstanceOf(SdkError);
        await expect(connectPromise).rejects.toThrow(/403 insufficient_scope after step-up re-authorization/);

        expect(refreshAs.tokenCalls).toHaveLength(1);
        expect(defined(refreshAs.tokenCalls[0], 'token call').body.get('grant_type')).toBe('refresh_token');
        expect(refreshMcpRequests).toHaveLength(2);
    } finally {
        await refreshClient.close();
    }
});

verifies('client-auth:stepup:scope-union', async (_args: TestArgs) => {
    // computeScopeUnion is a deliberate public export.
    expect(computeScopeUnion('files:read openid', 'files:write')).toBe('files:read openid files:write');
    expect(computeScopeUnion('admin', 'read')).toBe('admin read'); // no hierarchical collapse

    // The transport requests the union of its previously-requested scope and the
    // newly-challenged scope on step-up.
    const PREVIOUS_SCOPE = 'files:read openid';
    const CHALLENGED_SCOPE = 'files:write';
    const as = createMockAuthorizationServer();
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'read-token', token_type: 'Bearer', scope: PREVIOUS_SCOPE },
        clientInformation: { client_id: 'pre-registered-client' }
    });
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return as.handleRequest(new Request(url, init));
        }
        return new Response(null, {
            status: 403,
            headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${CHALLENGED_SCOPE}"` }
        });
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });
    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
        expect(provider.redirectedTo).toHaveLength(1);
        const redirect = defined(provider.redirectedTo[0], 'authorize URL');
        expect(redirect.searchParams.get('scope')).toBe('files:read openid files:write');
    } finally {
        await client.close();
    }
});

verifies(['client-auth:stepup:retry-cap', 'client-auth:stepup:refresh-bypass-on-superset'], async (_args: TestArgs) => {
    // Part A — superset bypass: token granted "files:read"; challenged scope adds
    // "files:write". Union strictly exceeds the token's grant → auth() forces a
    // fresh authorization request (no refresh-token POST observed).
    {
        const as = createMockAuthorizationServer();
        const provider = new RecordingOAuthClientProvider({
            tokens: { access_token: 't', token_type: 'Bearer', refresh_token: 'rt', scope: 'files:read' },
            clientInformation: { client_id: 'pre-registered-client' }
        });
        const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return as.handleRequest(new Request(url, init));
            }
            return new Response(null, {
                status: 403,
                headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="files:write"' }
            });
        };
        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });
        try {
            await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
            // Refresh was bypassed: no token-endpoint POST; the fresh authorize
            // request carries the union scope.
            expect(as.tokenCalls).toHaveLength(0);
            expect(provider.redirectedTo).toHaveLength(1);
            expect(defined(provider.redirectedTo[0], 'authorize URL').searchParams.get('scope')).toBe('files:read files:write');
            expect(isStrictScopeSuperset('files:read files:write', 'files:read')).toBe(true);
        } finally {
            await client.close();
        }
    }

    // Part B — refresh used + retry cap: token already covers the challenged
    // scope (server is misconfigured / hierarchical). Union is NOT a strict
    // superset → refresh is used. Server keeps 403'ing → per-send retry cap
    // (default 1) stops the loop after exactly one step-up.
    {
        const as = createMockAuthorizationServer({
            tokenResponses: [{ access_token: 't2', token_type: 'Bearer', scope: 'files:read files:write' }]
        });
        const provider = new RecordingOAuthClientProvider({
            tokens: { access_token: 't', token_type: 'Bearer', refresh_token: 'rt', scope: 'files:read files:write' },
            clientInformation: { client_id: 'pre-registered-client' }
        });
        const mcpPosts: string[] = [];
        const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return as.handleRequest(new Request(url, init));
            }
            mcpPosts.push(urlObj.pathname);
            return new Response(null, {
                status: 403,
                headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="files:write"' }
            });
        };
        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });
        try {
            const connectPromise = client.connect(transport);
            await expect(connectPromise).rejects.toBeInstanceOf(SdkError);
            await expect(connectPromise).rejects.toThrow(/retry limit 1 reached/);
            expect(as.tokenCalls).toHaveLength(1);
            expect(defined(as.tokenCalls[0], 'token call').body.get('grant_type')).toBe('refresh_token');
            expect(provider.redirectedTo).toHaveLength(0);
            expect(mcpPosts).toHaveLength(2);
            expect(isStrictScopeSuperset('files:read files:write', 'files:read files:write')).toBe(false);
        } finally {
            await client.close();
        }
    }
});

verifies('client-auth:stepup:throw-mode', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer();
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: 't', token_type: 'Bearer' },
        clientInformation: { client_id: 'pre-registered-client' }
    });
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return as.handleRequest(new Request(url, init));
        }
        return new Response(null, {
            status: 403,
            headers: {
                'WWW-Authenticate': `Bearer error="insufficient_scope", scope="files:write", resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource", error_description="write permission required"`
            }
        });
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: provider,
        fetch: combinedFetch,
        onInsufficientScope: 'throw'
    });
    try {
        const connectPromise = client.connect(transport);
        await expect(connectPromise).rejects.toBeInstanceOf(InsufficientScopeError);
        await expect(connectPromise).rejects.toMatchObject({
            requiredScope: 'files:write',
            errorDescription: 'write permission required',
            resourceMetadataUrl: new URL(`${MCP_URL}/.well-known/oauth-protected-resource`)
        });
        // No re-authorization was attempted.
        expect(as.tokenCalls).toHaveLength(0);
        expect(as.discoveryCalls).toHaveLength(0);
        expect(provider.redirectedTo).toHaveLength(0);
    } finally {
        await client.close();
    }
});

verifies('client-auth:stepup:get-stream-403', async (_args: TestArgs) => {
    // The GET listen-stream open path applies the same step-up handling.
    // We assert via 'throw' mode (parity with the POST path is the same private
    // helper) so the test observes the GET branch reaching the step-up gate.
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: 't', token_type: 'Bearer' },
        clientInformation: { client_id: 'pre-registered-client' }
    });
    const seenMethods: string[] = [];
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        seenMethods.push(init?.method ?? 'GET');
        return new Response(null, {
            status: 403,
            headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="listen"' }
        });
    };

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: provider,
        fetch: combinedFetch,
        onInsufficientScope: 'throw'
    });
    await transport.start();
    try {
        const resumePromise = transport.resumeStream('last-event-42');
        await expect(resumePromise).rejects.toBeInstanceOf(InsufficientScopeError);
        await expect(resumePromise).rejects.toMatchObject({ requiredScope: 'listen' });
        expect(seenMethods).toEqual(['GET']);
    } finally {
        await transport.close();
    }
});

verifies('client-auth:as-metadata-discovery:priority-order', async (_args: TestArgs) => {
    const oauthMetadata: AuthorizationServerMetadata = {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        response_types_supported: ['code']
    };
    const oidcMetadata = {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256']
    };

    // Serves metadata only at one path; everything else 404s so the fallback chain keeps probing.
    const makeDiscoveryFetch = (servedPath: string, payload: object) => {
        const calls: string[] = [];
        const fetchFn = async (url: URL | string, _init?: RequestInit) => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            calls.push(urlObj.pathname);
            if (urlObj.pathname === servedPath) {
                return Response.json(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('Not Found', { status: 404 });
        };
        return { calls, fetchFn };
    };

    // Path-less issuer: OAuth AS metadata is tried first and, when found, discovery stops there.
    const oauthFirst = makeDiscoveryFetch('/.well-known/oauth-authorization-server', oauthMetadata);
    expect(await discoverAuthorizationServerMetadata(ISSUER, { fetchFn: oauthFirst.fetchFn })).toMatchObject(oauthMetadata);
    expect(oauthFirst.calls).toEqual(['/.well-known/oauth-authorization-server']);

    // Path-less issuer without OAuth metadata: OIDC discovery is tried second.
    const oidcFallback = makeDiscoveryFetch('/.well-known/openid-configuration', oidcMetadata);
    expect(await discoverAuthorizationServerMetadata(ISSUER, { fetchFn: oidcFallback.fetchFn })).toMatchObject(oidcMetadata);
    expect(oidcFallback.calls).toEqual(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']);

    // Path-bearing issuer: path-inserted OAuth, then path-inserted OIDC, then path-appended OIDC.
    const tenantIssuer = `${ISSUER}/tenant1`;
    const tenantOidcMetadata = { ...oidcMetadata, issuer: tenantIssuer };
    const tenantFallback = makeDiscoveryFetch('/tenant1/.well-known/openid-configuration', tenantOidcMetadata);
    expect(await discoverAuthorizationServerMetadata(tenantIssuer, { fetchFn: tenantFallback.fetchFn })).toMatchObject(tenantOidcMetadata);
    expect(tenantFallback.calls).toEqual([
        '/.well-known/oauth-authorization-server/tenant1',
        '/.well-known/openid-configuration/tenant1',
        '/tenant1/.well-known/openid-configuration'
    ]);
});

verifies('client-auth:as-metadata-discovery:issuer-validation', async (_args: TestArgs) => {
    // RFC 8414 §3.3: metadata fetched from the AS URL claims a different issuer, so the document must be rejected.
    const as = createMockAuthorizationServer({ asMetadata: { issuer: 'https://attacker.example.com' } });
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('token-never-issued');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        const err: unknown = await client.connect(transport).catch((error: unknown) => error);
        expect(err).toBeInstanceOf(IssuerMismatchError);
        expect((err as IssuerMismatchError).kind).toBe('metadata');
        // Intentionally not an OAuthError — the auth() retry block must not swallow it.
        expect(err).not.toBeInstanceOf(OAuthError);

        // The mismatched metadata is rejected before registering, redirecting the user, or requesting tokens.
        expect(as.registerCalls).toHaveLength(0);
        expect(provider.redirectedTo).toHaveLength(0);
        expect(as.tokenCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

/**
 * Runs the redirect leg of the OAuth flow against a mock AS configured with `asMetadata`, then
 * calls `transport.finishAuth(code, iss)`. Returns the thrown error (or undefined on success)
 * and the recorded token-endpoint calls so the caller can assert whether the code went on the wire.
 */
async function runFinishAuthScenario(asMetadata: Partial<AuthorizationServerMetadata>, iss: string | undefined) {
    const as = createMockAuthorizationServer({ asMetadata, tokenResponses: [{ access_token: 'iss-flow-token', token_type: 'Bearer' }] });
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('iss-flow-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'iss-flow-token' });

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });
    const client = new Client({ name: 'c', version: '0' });
    try {
        // First connect → 401 → discovery → REDIRECT.
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
        expect(provider.redirectedTo).toHaveLength(1);

        let thrown: unknown;
        try {
            await transport.finishAuth('granted-code', iss);
        } catch (error) {
            thrown = error;
        }
        return { thrown, tokenCalls: as.tokenCalls, provider };
    } finally {
        await client.close();
        await mcpHost.close();
    }
}

verifies('client-auth:iss:match', async (_args: TestArgs) => {
    const { thrown, tokenCalls, provider } = await runFinishAuthScenario({ authorization_response_iss_parameter_supported: true }, ISSUER);
    expect(thrown).toBeUndefined();
    expect(tokenCalls).toHaveLength(1);
    expect(defined(tokenCalls[0], 'token call').body.get('code')).toBe('granted-code');
    expect(provider.saved.tokens?.access_token).toBe('iss-flow-token');
});

verifies('client-auth:iss:mismatch-reject', async (_args: TestArgs) => {
    const { thrown, tokenCalls } = await runFinishAuthScenario(
        { authorization_response_iss_parameter_supported: true },
        'https://attacker.example.com'
    );
    expect(thrown).toBeInstanceOf(IssuerMismatchError);
    expect((thrown as IssuerMismatchError).kind).toBe('authorization_response');
    expect((thrown as IssuerMismatchError).expected).toBe(ISSUER);
    // The authorization code never reaches a token endpoint.
    expect(tokenCalls).toHaveLength(0);
});

verifies('client-auth:iss:supported-missing-reject', async (_args: TestArgs) => {
    const { thrown, tokenCalls } = await runFinishAuthScenario({ authorization_response_iss_parameter_supported: true }, undefined);
    expect(thrown).toBeInstanceOf(IssuerMismatchError);
    expect((thrown as IssuerMismatchError).received).toBeUndefined();
    expect(tokenCalls).toHaveLength(0);
});

verifies('client-auth:iss:unadvertised-proceed', async (_args: TestArgs) => {
    // Row 4: not advertised + iss absent → the exchange proceeds. Also covers row 3 (not advertised
    // + iss present → still compared) by additionally asserting the same scenario rejects a wrong iss.
    const proceed = await runFinishAuthScenario({}, undefined);
    expect(proceed.thrown).toBeUndefined();
    expect(proceed.tokenCalls).toHaveLength(1);

    const reject = await runFinishAuthScenario({}, 'https://attacker.example.com');
    expect(reject.thrown).toBeInstanceOf(IssuerMismatchError);
    expect(reject.tokenCalls).toHaveLength(0);
});

verifies('client-auth:iss:no-normalize', async (_args: TestArgs) => {
    // Each value is URL-equivalent to ISSUER under RFC 3986 §6.2.2-6.2.3 normalization, but
    // RFC 9207 mandates simple string comparison — every one MUST be rejected.
    for (const iss of [ISSUER.toUpperCase(), `${ISSUER}/`, `${ISSUER}:443`, ISSUER.replace('https', 'HTTPS')]) {
        expect(() => validateAuthorizationResponseIssuer({ iss, expectedIssuer: ISSUER, issParameterSupported: true })).toThrow(
            IssuerMismatchError
        );
    }

    // And end-to-end through finishAuth(): a trailing-slash difference is a real reject.
    const { thrown, tokenCalls } = await runFinishAuthScenario({ authorization_response_iss_parameter_supported: true }, `${ISSUER}/`);
    expect(thrown).toBeInstanceOf(IssuerMismatchError);
    expect(tokenCalls).toHaveLength(0);
});

verifies('client-auth:iss:opt-out', async (_args: TestArgs) => {
    // skipIssuerMetadataValidation suppresses AU-02 (metadata echo): mismatched-issuer metadata is accepted.
    const as = createMockAuthorizationServer({ asMetadata: { issuer: 'https://misconfigured.example.com' } });
    const fetchFn = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));
    const provider = new RecordingOAuthClientProvider();
    await auth(provider, { serverUrl: MCP_URL, skipIssuerMetadataValidation: true, fetchFn });
    expect(provider.redirectedTo).toHaveLength(1);

    // It does NOT suppress AU-01 (callback iss): a mismatched iss is still rejected before token exchange.
    await expect(
        auth(provider, {
            serverUrl: MCP_URL,
            authorizationCode: 'granted-code',
            iss: 'https://attacker.example.com',
            skipIssuerMetadataValidation: true,
            fetchFn
        })
    ).rejects.toThrow(IssuerMismatchError);
    expect(as.tokenCalls).toHaveLength(0);
});

verifies('client-auth:bearer-header:every-request', async (_args: TestArgs) => {
    const validToken = 'bearer-test-token';
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: validToken, token_type: 'Bearer' },
        clientInformation: { client_id: 'test-client' }
    });
    const mcpHost = createAuthenticatedHost(validToken);

    const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const recordingFetch = async (url: URL | string, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of new Headers(init?.headers).entries()) {
            headers[k] = v;
        }
        requests.push({ method: init?.method ?? 'GET', url: String(url), headers });
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: recordingFetch });

    try {
        await client.connect(transport);
        await client.callTool({ name: 'probe', arguments: {} });

        // The standalone SSE GET is opened fire-and-forget after initialize; wait for it so it is checked too.
        await vi.waitFor(() => expect(requests.some(r => r.method === 'GET')).toBe(true));

        const mcpRequests = requests.filter(r => new URL(r.url).pathname === '/mcp');
        expect(mcpRequests).toHaveLength(requests.length);
        // Exactly three POSTs: initialize, notifications/initialized, tools/call.
        expect(mcpRequests.filter(r => r.method === 'POST')).toHaveLength(3);

        for (const req of mcpRequests) {
            expect(req.headers['authorization']).toBe(`Bearer ${validToken}`);
            expect(new URL(req.url).search).not.toContain(validToken);
            expect(new URL(req.url).search).not.toMatch(/access_token/i);
        }
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:cimd', async (_args: TestArgs) => {
    const cimdUrl = 'https://client.example.com/.well-known/client-metadata.json';
    const as = createMockAuthorizationServer({
        asMetadata: { client_id_metadata_document_supported: true }
    });
    const provider = new RecordingOAuthClientProvider({ clientMetadataUrl: cimdUrl });
    const mcpHost = createAuthenticatedHost('cimd-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'cimd-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // The CIMD URL is used directly as the client_id; no dynamic registration happens.
        expect(provider.saved.clientInformation?.client_id).toBe(cimdUrl);
        expect(provider.redirectedTo).toHaveLength(1);
        expect(defined(provider.redirectedTo[0], 'authorization redirect URL').searchParams.get('client_id')).toBe(cimdUrl);
        expect(as.registerCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:client-credentials', async (_args: TestArgs) => {
    const ISSUED = 'cc-issued-access-token';
    const CLIENT_ID = 'machine-client';
    const CLIENT_SECRET = 'machine-client-secret';

    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: ISSUED, token_type: 'Bearer' }]
    });
    const mcpHost = createAuthenticatedHost(ISSUED);
    const baseFetch = createCombinedFetch({ as, mcpHost, validToken: ISSUED });

    const mcpAuthHeaders: Array<string | null> = [];
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin !== ISSUER && !urlObj.pathname.includes('/.well-known/')) {
            mcpAuthHeaders.push(new Headers(init?.headers).get('authorization'));
        }
        return baseFetch(url, init);
    };

    const provider = new ClientCredentialsProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.some(t => t.name === 'probe')).toBe(true);

        // Token obtained via the client_credentials grant, authenticated with the configured secret.
        expect(as.tokenCalls).toHaveLength(1);
        const tokenCall = defined(as.tokenCalls[0], 'token call');
        expect(tokenCall.body.get('grant_type')).toBe('client_credentials');
        const basicHeader = defined(tokenCall.headers['authorization'], 'Basic authorization header');
        expect(basicHeader).toMatch(/^Basic /);
        expect(Buffer.from(basicHeader.replace(/^Basic /, ''), 'base64').toString()).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);

        // No user interaction: the authorization endpoint is never visited.
        expect(as.authorizeCalls).toHaveLength(0);

        // The issued bearer token authorizes every subsequent MCP request.
        expect(provider.tokens()?.access_token).toBe(ISSUED);
        expect(mcpAuthHeaders[0]).toBeNull();
        expect(mcpAuthHeaders.length).toBeGreaterThanOrEqual(2);
        for (const header of mcpAuthHeaders.slice(1)) {
            expect(header).toBe(`Bearer ${ISSUED}`);
        }
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:dcr', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer();
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('dcr-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'dcr-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // No client_id was preconfigured, so the SDK must register at the AS /register endpoint.
        expect(as.registerCalls).toHaveLength(1);
        const registerCall = defined(as.registerCalls[0], 'registration call');
        expect(registerCall.body.client_name).toBe('Test Client');
        expect(registerCall.body.redirect_uris).toContain('http://localhost:3000/callback');

        // The issued client_id is persisted and used for the authorization request.
        expect(provider.saved.clientInformation?.client_id).toBe('registered-client-id');
        expect(provider.redirectedTo).toHaveLength(1);
        expect(defined(provider.redirectedTo[0], 'authorization redirect URL').searchParams.get('client_id')).toBe('registered-client-id');
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:invalid-client-clears-all', async (_args: TestArgs) => {
    // Both error codes must clear all stored credentials (client registration and tokens).
    for (const errorCode of ['invalid_client', 'unauthorized_client']) {
        const as = createMockAuthorizationServer({
            tokenErrorResponses: [{ error: errorCode, error_description: 'Client registration is no longer valid' }]
        });
        const provider = new RecordingOAuthClientProvider({
            tokens: { access_token: 'stale-access-token', token_type: 'Bearer', refresh_token: 'stale-refresh-token' },
            clientInformation: { client_id: 'revoked-client-id', client_secret: 'revoked-client-secret' }
        });
        const mcpHost = createAuthenticatedHost('token-never-issued');
        const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        try {
            await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

            // The refresh attempt with the stale registration is what surfaced the error.
            expect(as.tokenCalls).toHaveLength(1);
            expect(defined(as.tokenCalls[0], 'token call').body.get('grant_type')).toBe('refresh_token');

            // Everything is invalidated: tokens are gone and the stale client_id was discarded,
            // forcing a fresh dynamic registration on the retry.
            expect(provider.invalidatedCredentials).toContain('all');
            expect(provider.saved.tokens).toBeUndefined();
            expect(as.registerCalls).toHaveLength(1);
            expect(provider.saved.clientInformation?.client_id).toBe('registered-client-id');
        } finally {
            await client.close();
            await mcpHost.close();
        }
    }
});

verifies('client-auth:invalid-grant-clears-tokens', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({
        tokenErrorResponses: [{ error: 'invalid_grant', error_description: 'Refresh token expired' }]
    });
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'expired-access-token', token_type: 'Bearer', refresh_token: 'expired-refresh-token' },
        clientInformation: { client_id: 'still-valid-client' }
    });
    const mcpHost = createAuthenticatedHost('token-never-issued');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // The refresh attempt with the expired grant is what surfaced the error.
        expect(as.tokenCalls).toHaveLength(1);
        expect(defined(as.tokenCalls[0], 'token call').body.get('grant_type')).toBe('refresh_token');

        // Only tokens are invalidated; the client registration is kept and reused (no re-registration).
        expect(provider.invalidatedCredentials).toContain('tokens');
        expect(provider.invalidatedCredentials).not.toContain('all');
        expect(provider.saved.tokens).toBeUndefined();
        expect(provider.saved.clientInformation?.client_id).toBe('still-valid-client');
        expect(as.registerCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:pkce:refuse-if-unsupported', async (_args: TestArgs) => {
    // AS metadata advertises code_challenge_methods_supported without S256 (only "plain").
    const as = createMockAuthorizationServer({ refusePKCE: true });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'pkce-strict-client' } });
    const mcpHost = createAuthenticatedHost('token-never-issued');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(/S256/);

        // The flow stops before any user redirect or token request.
        expect(provider.redirectedTo).toHaveLength(0);
        expect(as.authorizeCalls).toHaveLength(0);
        expect(as.tokenCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:pkce:s256', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({ tokenResponses: [{ access_token: 'pkce-token', token_type: 'Bearer' }] });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'pkce-client' } });
    const mcpHost = createAuthenticatedHost('pkce-token');

    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'pkce-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        const authorizeUrl = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
        const challenge = authorizeUrl.searchParams.get('code_challenge');
        expect(challenge).toBeTruthy();

        const verifier = defined(provider.saved.codeVerifier, 'saved code verifier');
        expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
        const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
        expect(challenge).toBe(expectedChallenge);

        await transport.finishAuth('mock-code');
        expect(as.tokenCalls).toHaveLength(1);
        expect(defined(as.tokenCalls[0], 'token call').body.get('code_verifier')).toBe(verifier);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:pre-registration', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({ tokenResponses: [{ access_token: 'pre-reg-token', token_type: 'Bearer' }] });
    const provider = new RecordingOAuthClientProvider({
        clientInformation: { client_id: 'pre-registered-client', client_secret: 'pre-registered-secret' }
    });
    const mcpHost = createAuthenticatedHost('pre-reg-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'pre-reg-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // DCR is skipped: the preconfigured client_id is what reaches the AS authorize endpoint.
        expect(as.registerCalls).toHaveLength(0);
        expect(provider.redirectedTo).toHaveLength(1);
        const redirect = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(redirect.origin).toBe(ISSUER);
        expect(redirect.pathname).toBe('/authorize');
        expect(redirect.searchParams.get('client_id')).toBe('pre-registered-client');

        // The token exchange authenticates with the preconfigured secret.
        await transport.finishAuth('granted-authorization-code');
        expect(as.tokenCalls).toHaveLength(1);
        const tokenCall = defined(as.tokenCalls[0], 'token call');
        expect(tokenCall.body.get('grant_type')).toBe('authorization_code');
        const basicHeader = defined(tokenCall.headers['authorization'], 'Basic authorization header');
        expect(basicHeader).toMatch(/^Basic /);
        expect(Buffer.from(basicHeader.replace(/^Basic /, ''), 'base64').toString()).toBe('pre-registered-client:pre-registered-secret');
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:private-key-jwt', async (_args: TestArgs) => {
    const ISSUED = 'jwt-issued-access-token';
    const CLIENT_ID = 'jwt-machine-client';

    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: ISSUED, token_type: 'Bearer' }]
    });
    const mcpHost = createAuthenticatedHost(ISSUED);
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: ISSUED });

    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const provider = new PrivateKeyJwtProvider({ clientId: CLIENT_ID, privateKey: privateKeyPem, algorithm: 'RS256' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.some(t => t.name === 'probe')).toBe(true);

        expect(as.tokenCalls).toHaveLength(1);
        const tokenCall = defined(as.tokenCalls[0], 'token call');
        const body = tokenCall.body;
        expect(body.get('grant_type')).toBe('client_credentials');
        expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

        // The client authenticates with a JWT signed by its private key — no shared secret anywhere.
        expect(body.get('client_secret')).toBeNull();
        expect(tokenCall.headers['authorization']).toBeUndefined();

        const assertion = body.get('client_assertion');
        expect(assertion).toBeTruthy();
        if (assertion === null) throw new Error('Expected a client_assertion in the token request body');
        const verificationKey = await importSPKI(publicKeyPem, 'RS256');
        const { payload } = await jwtVerify(assertion, verificationKey);
        expect(payload.iss).toBe(CLIENT_ID);
        expect(payload.sub).toBe(CLIENT_ID);
        expect(payload.aud).toBe(ISSUER);

        // No user interaction was needed.
        expect(as.authorizeCalls).toHaveLength(0);
        expect(provider.tokens()?.access_token).toBe(ISSUED);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:prm-discovery:fallback-order', async (_args: TestArgs) => {
    const discoveryCalls: string[] = [];
    const prmMetadata = { resource: RESOURCE, authorization_servers: [ISSUER] };

    const discoveryFetch = async (url: URL | string) => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        const path = urlObj.pathname;
        discoveryCalls.push(path);

        if (path === '/.well-known/oauth-protected-resource/mcp') {
            return Response.json(prmMetadata, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not Found', { status: 404 });
    };

    const result = await discoverOAuthProtectedResourceMetadata(MCP_URL, { protocolVersion: LATEST_PROTOCOL_VERSION }, discoveryFetch);
    expect(result).toMatchObject(prmMetadata);
    expect(discoveryCalls[0]).toBe('/.well-known/oauth-protected-resource/mcp');
});

verifies('client-auth:prm-discovery:no-prm-fallback', async (_args: TestArgs) => {
    const VALID = 'legacy-fallback-token';
    // RFC 8414 §3.3: metadata fetched at the MCP origin must claim that origin as its issuer.
    const as = createMockAuthorizationServer({
        noPRMDiscovery: true,
        asMetadata: { issuer: new URL(MCP_URL).origin },
        tokenResponses: [{ access_token: VALID, token_type: 'Bearer' }]
    });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'legacy-fallback-client' } });
    const mcpHost = createAuthenticatedHost(VALID);

    const wellKnownRequests: string[] = [];
    // Legacy-style resource server: 401 challenges carry no resource_metadata hint, so the client must probe on its own.
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.pathname.includes('/.well-known/')) {
            wellKnownRequests.push(`${urlObj.origin}${urlObj.pathname}`);
            return as.handleRequest(new Request(url, init));
        }
        if (urlObj.origin === ISSUER) {
            return as.handleRequest(new Request(url, init));
        }
        const h = new Headers(init?.headers);
        if (h.get('authorization') !== `Bearer ${VALID}`) {
            return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' } });
        }
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // Both PRM probes 404, then AS metadata is discovered directly at the MCP server's origin (legacy 2025-03-26 path).
        const origin = new URL(MCP_URL).origin;
        expect(wellKnownRequests).toEqual([
            `${origin}/.well-known/oauth-protected-resource/mcp`,
            `${origin}/.well-known/oauth-protected-resource`,
            `${origin}/.well-known/oauth-authorization-server`
        ]);

        // The flow proceeds with the authorization endpoint from the origin-discovered metadata instead of aborting.
        expect(provider.redirectedTo).toHaveLength(1);
        const redirect = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/authorize`);
        expect(redirect.searchParams.get('client_id')).toBe('legacy-fallback-client');

        // The same origin-discovered metadata drives the code exchange at the AS token endpoint.
        await transport.finishAuth('granted-authorization-code');
        expect(as.tokenCalls).toHaveLength(1);
        const tokenCall = defined(as.tokenCalls[0], 'token call');
        expect(tokenCall.body.get('grant_type')).toBe('authorization_code');
        expect(tokenCall.body.get('code')).toBe('granted-authorization-code');
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:prm-resource-mismatch', async (_args: TestArgs) => {
    // PRM document declares a resource that is not the MCP server the client is connecting to.
    const as = createMockAuthorizationServer({ resourceMismatch: true });
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('token-never-issued');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(/resource.*does not match/i);

        // The client refuses before registering, redirecting, or requesting tokens.
        expect(as.registerCalls).toHaveLength(0);
        expect(provider.redirectedTo).toHaveLength(0);
        expect(as.tokenCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:refresh:transparent', async (_args: TestArgs) => {
    const STALE = 'expired-access-token';
    const REFRESHED = 'refreshed-access-token';

    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: REFRESHED, token_type: 'Bearer', refresh_token: 'rotated-refresh-token' }]
    });
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: STALE, token_type: 'Bearer', refresh_token: 'long-lived-refresh-token' },
        clientInformation: { client_id: 'refresh-client' }
    });
    // Token validity is enforced at the HTTP layer (createCombinedFetch), so the tool itself carries no auth check.
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'ok' }] }));
        return s;
    });
    const baseFetch = createCombinedFetch({ as, mcpHost, validToken: REFRESHED });

    const mcpPostBearers: Array<string | null> = [];
    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin !== ISSUER && !urlObj.pathname.includes('/.well-known/') && init?.method === 'POST') {
            mcpPostBearers.push(new Headers(init?.headers).get('authorization'));
        }
        return baseFetch(url, init);
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'probe', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

        // Exactly one refresh_token grant, carrying the stored refresh token and the resource indicator.
        expect(as.tokenCalls).toHaveLength(1);
        const refreshCall = defined(as.tokenCalls[0], 'token call');
        expect(refreshCall.body.get('grant_type')).toBe('refresh_token');
        expect(refreshCall.body.get('refresh_token')).toBe('long-lived-refresh-token');
        expect(refreshCall.body.get('resource')).toBe(RESOURCE);

        // The refresh is transparent (no user-facing redirect) and the rotated token set is persisted.
        expect(provider.redirectedTo).toHaveLength(0);
        expect(provider.saved.tokens?.access_token).toBe(REFRESHED);
        expect(provider.saved.tokens?.refresh_token).toBe('rotated-refresh-token');

        // Only the rejected initialize used the expired bearer; its retry, initialized, and tools/call all use the new one.
        expect(mcpPostBearers).toEqual([`Bearer ${STALE}`, `Bearer ${REFRESHED}`, `Bearer ${REFRESHED}`, `Bearer ${REFRESHED}`]);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:resource-parameter', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({ tokenResponses: [{ access_token: 'resource-param-token', token_type: 'Bearer' }] });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'resource-test-client' } });
    const mcpHost = createAuthenticatedHost('resource-param-token');

    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'resource-param-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        const authorizeUrl = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(authorizeUrl.searchParams.get('resource')).toBe(RESOURCE);

        await transport.finishAuth('mock-code');
        expect(defined(as.tokenCalls[0], 'token call').body.get('resource')).toBe(RESOURCE);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:scope-selection:priority', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({ tokenResponses: [{ access_token: 'scope-token', token_type: 'Bearer' }] });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'scope-client' } });
    const mcpHost = createAuthenticatedHost('scope-token');

    const combinedFetch = (url: URL | string, init?: RequestInit) => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER) {
            return as.handleRequest(new Request(url, init));
        }
        const h = new Headers(init?.headers);
        if (!h.has('authorization')) {
            return Promise.resolve(
                new Response(null, {
                    status: 401,
                    headers: {
                        'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource" scope="mcp:custom"`
                    }
                })
            );
        }
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
        const authorizeUrl = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(authorizeUrl.searchParams.get('scope')).toBe('mcp:custom');
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('typescript:client-auth:state:verify', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer();
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'state-client' } });
    const mcpHost = createAuthenticatedHost('state-token');

    const combinedFetch = (url: URL | string, init?: RequestInit) => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER) {
            return as.handleRequest(new Request(url, init));
        }
        const h = new Headers(init?.headers);
        if (!h.has('authorization')) {
            return Promise.resolve(
                new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"` }
                })
            );
        }
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
        const authorizeUrl = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(authorizeUrl.searchParams.get('state')).toBe(provider.saved.state);
        expect(provider.saved.state).toMatch(/^state-\d+$/);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:token-endpoint-auth-method', async (_args: TestArgs) => {
    // The registration response dictates how the client authenticates to /token.
    const REGISTERED_ID = 'auth-method-client';
    const REGISTERED_SECRET = 'auth-method-client-secret';

    for (const method of ['client_secret_basic', 'client_secret_post', 'none'] as const) {
        const as = createMockAuthorizationServer({
            tokenResponses: [{ access_token: 'auth-method-access-token', token_type: 'Bearer' }],
            registerResponse:
                method === 'none'
                    ? // Public client: client_secret: undefined suppresses the mock's default issued secret.
                      { client_id: REGISTERED_ID, client_secret: undefined, token_endpoint_auth_method: method }
                    : { client_id: REGISTERED_ID, client_secret: REGISTERED_SECRET, token_endpoint_auth_method: method }
        });
        const provider = new RecordingOAuthClientProvider();
        const mcpHost = createAuthenticatedHost('auth-method-access-token');
        const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'auth-method-access-token' });

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        try {
            await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
            expect(provider.saved.clientInformation?.client_id).toBe(REGISTERED_ID);

            await transport.finishAuth('granted-authorization-code');

            expect(as.tokenCalls).toHaveLength(1);
            const tokenCall = defined(as.tokenCalls[0], 'token call');
            expect(tokenCall.body.get('grant_type')).toBe('authorization_code');

            if (method === 'client_secret_basic') {
                const authHeader = defined(tokenCall.headers['authorization'], 'Basic authorization header');
                expect(authHeader).toMatch(/^Basic /);
                expect(Buffer.from(authHeader.replace(/^Basic /, ''), 'base64').toString()).toBe(`${REGISTERED_ID}:${REGISTERED_SECRET}`);
                expect(tokenCall.body.get('client_secret')).toBeNull();
            } else if (method === 'client_secret_post') {
                // client_secret_post: credentials travel in the form body, not the Authorization header.
                expect(tokenCall.headers['authorization']).toBeUndefined();
                expect(tokenCall.body.get('client_id')).toBe(REGISTERED_ID);
                expect(tokenCall.body.get('client_secret')).toBe(REGISTERED_SECRET);
            } else {
                // none: public client identifies via client_id in the body only — no secret, no Authorization header.
                expect(tokenCall.headers['authorization']).toBeUndefined();
                expect(tokenCall.body.get('client_id')).toBe(REGISTERED_ID);
                expect(tokenCall.body.get('client_secret')).toBeNull();
            }
        } finally {
            await client.close();
            await mcpHost.close();
        }
    }
});

verifies('client-auth:low-level:discover-and-exchange', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: 'low-level-access-token', token_type: 'Bearer' }]
    });
    const discoveryFetch = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

    const clientInformation = { client_id: 'low-level-public-client' };
    const redirectUri = 'http://localhost:3000/callback';

    const prm = await discoverOAuthProtectedResourceMetadata(MCP_URL, { protocolVersion: LATEST_PROTOCOL_VERSION }, discoveryFetch);
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toContain(ISSUER);

    const authorizationServer = prm.authorization_servers?.[0];
    if (!authorizationServer) throw new Error('protected resource metadata did not list an authorization server');

    const asMetadata = await discoverAuthorizationServerMetadata(authorizationServer, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        fetchFn: discoveryFetch
    });
    if (!asMetadata) throw new Error('authorization server metadata discovery returned undefined');
    expect(asMetadata.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(asMetadata.token_endpoint).toBe(`${ISSUER}/token`);

    const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServer, {
        metadata: asMetadata,
        clientInformation,
        redirectUrl: redirectUri,
        scope: prm.scopes_supported?.join(' '),
        resource: new URL(prm.resource)
    });

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(asMetadata.authorization_endpoint);
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('client_id')).toBe(clientInformation.client_id);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authorizationUrl.searchParams.get('resource')).toBe(prm.resource);
    expect(authorizationUrl.searchParams.get('scope')).toBe('mcp:read mcp:write');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge in the URL must be the S256 transform of the verifier the helper handed back.
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));

    const tokens = await exchangeAuthorization(authorizationServer, {
        metadata: asMetadata,
        clientInformation,
        authorizationCode: 'granted-authorization-code',
        redirectUri,
        codeVerifier,
        resource: new URL(prm.resource),
        fetchFn: discoveryFetch
    });

    expect(tokens.access_token).toBe('low-level-access-token');
    expect(as.tokenCalls).toHaveLength(1);
    const tokenBody = defined(as.tokenCalls[0], 'token call').body;
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('code')).toBe('granted-authorization-code');
    expect(tokenBody.get('code_verifier')).toBe(codeVerifier);
    expect(tokenBody.get('redirect_uri')).toBe(redirectUri);
    expect(tokenBody.get('resource')).toBe(prm.resource);
    expect(tokenBody.get('client_id')).toBe(clientInformation.client_id);
});

verifies('client-auth:private-key-jwt:static-assertion', async (_args: TestArgs) => {
    const ISSUED = 'static-jwt-issued-access-token';
    const CLIENT_ID = 'static-assertion-client';

    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const payload = JSON.stringify({
        iss: CLIENT_ID,
        sub: CLIENT_ID,
        aud: `${ISSUER}/token`,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
    });

    const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
    const encodedHeader = Buffer.from(header).toString('base64url');
    const encodedPayload = Buffer.from(payload).toString('base64url');
    const signatureInput = `${encodedHeader}.${encodedPayload}`;
    const signature = sign('sha256', Buffer.from(signatureInput), privateKeyPem);
    const preBuiltJwt = `${signatureInput}.${signature.toString('base64url')}`;

    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: ISSUED, token_type: 'Bearer' }]
    });
    const mcpHost = createAuthenticatedHost(ISSUED);
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: ISSUED });

    const provider = new StaticPrivateKeyJwtProvider({
        clientId: CLIENT_ID,
        jwtBearerAssertion: preBuiltJwt
    });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.some(t => t.name === 'probe')).toBe(true);

        // The pre-built assertion is sent verbatim — no per-request signing changes it.
        expect(as.tokenCalls).toHaveLength(1);
        const body = defined(as.tokenCalls[0], 'token call').body;
        expect(body.get('grant_type')).toBe('client_credentials');
        expect(body.get('client_assertion')).toBe(preBuiltJwt);
        expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

        // Fixed client_id, so DCR is skipped and no user interaction occurs.
        expect(as.registerCalls).toHaveLength(0);
        expect(as.authorizeCalls).toHaveLength(0);
        expect(provider.tokens()?.access_token).toBe(ISSUED);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-middleware:compose', async (_args: TestArgs) => {
    const TRACE = 'x-mw-trace';

    const appendTrace = (init: RequestInit | undefined, tag: string): Headers => {
        const headers = new Headers(init?.headers);
        const prior = headers.get(TRACE);
        headers.set(TRACE, prior ? `${prior}>${tag}` : tag);
        return headers;
    };

    const first = createMiddleware(async (next, input, init) => {
        const headers = appendTrace(init, 'first');
        headers.set('x-mw-first', '1');
        return next(input, { ...init, headers });
    });

    const second = createMiddleware(async (next, input, init) => {
        const headers = appendTrace(init, 'second');
        headers.set('x-mw-second', '1');
        return next(input, { ...init, headers });
    });

    const seenByServer: Headers[] = [];
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('report-headers', { inputSchema: z.object({}) }, (_a, ctx) => {
            seenByServer.push(ctx.http?.req?.headers ?? new Headers());
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    });

    const baseRequests: Array<{ method: string; headers: Record<string, string> }> = [];
    const baseFetch = async (url: URL | string, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of new Headers(init?.headers).entries()) {
            headers[k] = v;
        }
        baseRequests.push({ method: init?.method ?? 'GET', headers });
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: applyMiddlewares(first, second)(baseFetch) });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'report-headers', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

        // Every HTTP request the transport made passed through both layers before the base fetch.
        expect(baseRequests.filter(r => r.method === 'POST')).toHaveLength(3);
        for (const req of baseRequests) {
            expect(req.headers['x-mw-first']).toBe('1');
            expect(req.headers['x-mw-second']).toBe('1');
            expect(req.headers[TRACE]).toBe('second>first');
        }

        // The middleware-set headers arrived at the MCP server on the tools/call request.
        expect(seenByServer).toHaveLength(1);
        const serverHeaders = defined(seenByServer[0], 'tools/call request headers');
        expect(serverHeaders.get('x-mw-first')).toBe('1');
        expect(serverHeaders.get('x-mw-second')).toBe('1');
        expect(serverHeaders.get(TRACE)).toBe('second>first');
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-middleware:with-logging', async (_args: TestArgs) => {
    const logs: Array<{ method: string; url: string | URL; status: number; duration: number }> = [];
    const logger = (input: { method: string; url: string | URL; status: number; duration: number }) => {
        logs.push({ method: input.method, url: input.url, status: input.status, duration: input.duration });
    };

    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
            content: [{ type: 'text', text: `Hello, ${name}!` }]
        }));
        return s;
    });

    const httpRequests: Array<{ method: string; url: string }> = [];
    const baseFetch = async (url: URL | string, init?: RequestInit) => {
        httpRequests.push({ method: init?.method ?? 'GET', url: String(url) });
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: withLogging({ logger })(baseFetch) });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });

        // The response is passed through unmodified: the MCP call result is exactly what the server returned.
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada!' }]);

        // Restrict to POSTs: the standalone SSE GET is fire-and-forget, so its log entry timing is not deterministic.
        const postRequests = httpRequests.filter(r => r.method === 'POST');
        const postLogs = logs.filter(l => l.method === 'POST');
        expect(postRequests).toHaveLength(3);
        // One log entry per HTTP request: initialize (200), notifications/initialized (202), tools/call (200).
        expect(postLogs.map(l => l.status)).toEqual([200, 202, 200]);
        for (const log of postLogs) {
            expect(String(log.url)).toBe(MCP_URL);
            expect(log.duration).toBeGreaterThan(0);
        }
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:middleware:with-oauth', async (_args: TestArgs) => {
    const STALE = 'stale-access-token';
    const REFRESHED = 'refreshed-access-token';
    const wwwAuthenticate = `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"`;

    // Phase 1: bearer header from tokens(); on 401 the middleware refreshes and retries once with the new token.
    const refreshAs = createMockAuthorizationServer({
        tokenResponses: [{ access_token: REFRESHED, token_type: 'Bearer', refresh_token: 'rotated-refresh-token' }]
    });
    const mcpHost = createAuthenticatedHost(REFRESHED);
    const refreshProvider = new RecordingOAuthClientProvider({
        clientInformation: { client_id: 'oauth-middleware-client' },
        tokens: { access_token: STALE, token_type: 'Bearer', refresh_token: 'initial-refresh-token' }
    });

    const mcpAuthHeaders: Array<string | null> = [];
    const refreshBaseFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return refreshAs.handleRequest(new Request(url, init));
        }
        const authHeader = new Headers(init?.headers).get('authorization');
        mcpAuthHeaders.push(authHeader);
        if (authHeader !== `Bearer ${REFRESHED}`) {
            return new Response(null, { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } });
        }
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        fetch: withOAuth(refreshProvider, MCP_URL)(refreshBaseFetch)
    });

    try {
        await client.connect(transport);

        expect(refreshProvider.saved.tokens?.access_token).toBe(REFRESHED);
        expect(refreshAs.tokenCalls).toHaveLength(1);
        const refreshCall = defined(refreshAs.tokenCalls[0], 'token call');
        expect(refreshCall.body.get('grant_type')).toBe('refresh_token');
        expect(refreshCall.body.get('refresh_token')).toBe('initial-refresh-token');

        expect(mcpAuthHeaders.length).toBeGreaterThanOrEqual(2);
        expect(mcpAuthHeaders[0]).toBe(`Bearer ${STALE}`);
        for (const header of mcpAuthHeaders.slice(1)) {
            expect(header).toBe(`Bearer ${REFRESHED}`);
        }
    } finally {
        await client.close();
        await mcpHost.close();
    }

    // Phase 2: a REDIRECT auth result (no refresh token, interactive flow needed) surfaces as UnauthorizedError.
    const redirectAs = createMockAuthorizationServer();
    const redirectProvider = new RecordingOAuthClientProvider({
        clientInformation: { client_id: 'oauth-middleware-client' },
        tokens: { access_token: STALE, token_type: 'Bearer' }
    });
    const redirectBaseFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return redirectAs.handleRequest(new Request(url, init));
        }
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } });
    };
    const redirectingFetch = withOAuth(redirectProvider, MCP_URL)(redirectBaseFetch);

    const redirectAttempt = redirectingFetch(MCP_URL, { method: 'POST' });
    await expect(redirectAttempt).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(redirectAttempt).rejects.toThrow(/redirect initiated/);
    expect(redirectProvider.redirectedTo).toHaveLength(1);

    // Phase 3: a second 401 after a successful re-auth throws instead of retrying again.
    const stubbornAs = createMockAuthorizationServer({
        tokenResponses: [{ access_token: REFRESHED, token_type: 'Bearer' }]
    });
    const stubbornProvider = new RecordingOAuthClientProvider({
        clientInformation: { client_id: 'oauth-middleware-client' },
        tokens: { access_token: STALE, token_type: 'Bearer', refresh_token: 'initial-refresh-token' }
    });
    let stubbornMcpRequests = 0;
    const stubbornBaseFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return stubbornAs.handleRequest(new Request(url, init));
        }
        stubbornMcpRequests++;
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } });
    };
    const stubbornFetch = withOAuth(stubbornProvider, MCP_URL)(stubbornBaseFetch);

    const stubbornAttempt = stubbornFetch(MCP_URL, { method: 'POST' });
    await expect(stubbornAttempt).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(stubbornAttempt).rejects.toThrow(/Authentication failed for/);
    expect(stubbornAs.tokenCalls).toHaveLength(1);
    expect(stubbornMcpRequests).toBe(2);
});

verifies('client-auth:oauth-error:consolidated-class', async (_args: TestArgs) => {
    // Each token-endpoint error response must surface as the single consolidated OAuthError class with a machine-readable code.
    const cases = [
        { errorCode: 'invalid_grant', description: 'Authorization code expired', expectedCode: OAuthErrorCode.InvalidGrant },
        { errorCode: 'invalid_client', description: 'Client authentication failed', expectedCode: OAuthErrorCode.InvalidClient }
    ];

    for (const { errorCode, description, expectedCode } of cases) {
        const as = createMockAuthorizationServer({ tokenErrorResponses: [{ error: errorCode, error_description: description }] });
        const tokenFetch = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

        let failure: unknown;
        try {
            await exchangeAuthorization(ISSUER, {
                metadata: {
                    issuer: ISSUER,
                    authorization_endpoint: `${ISSUER}/authorize`,
                    token_endpoint: `${ISSUER}/token`,
                    response_types_supported: ['code']
                },
                clientInformation: { client_id: 'oauth-error-client' },
                authorizationCode: 'granted-authorization-code',
                codeVerifier: 'oauth-error-code-verifier',
                redirectUri: 'http://localhost:3000/callback',
                fetchFn: tokenFetch
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(OAuthError);
        if (!(failure instanceof OAuthError)) throw new Error('Expected exchangeAuthorization to reject with OAuthError');

        // The consolidated class is thrown directly (not a per-code subclass) and carries the wire error code on .code.
        expect(Object.getPrototypeOf(failure)).toBe(OAuthError.prototype);
        expect(failure.name).toBe('OAuthError');
        expect(failure.code).toBe(expectedCode);
        expect(failure.message).toBe(description);
        expect(failure.toResponseObject()).toEqual({ error: errorCode, error_description: description });

        // The error came from the single token request the exchange made.
        expect(as.tokenCalls).toHaveLength(1);
    }
});

verifies('client-auth:authprovider:token-attached', async (_args: TestArgs) => {
    const TOKEN = 'minimal-provider-bearer-token';

    let tokenCalls = 0;
    // Minimal AuthProvider shape: token() only — no OAuth machinery, no onUnauthorized.
    const authProvider: AuthProvider = {
        token: async () => {
            tokenCalls += 1;
            return TOKEN;
        }
    };

    const authorizationSeenByServer: Array<string | null> = [];
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, (_a, ctx) => {
            authorizationSeenByServer.push(ctx.http?.req?.headers.get('authorization') ?? null);
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    });

    const requests: Array<{ method: string; authorization: string | null }> = [];
    const recordingFetch = async (url: URL | string, init?: RequestInit) => {
        requests.push({ method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider, fetch: recordingFetch });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'probe', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

        // The standalone SSE GET is opened fire-and-forget after initialize; wait for it so it is checked too.
        await vi.waitFor(() => expect(requests.some(r => r.method === 'GET')).toBe(true));

        // Exactly three POSTs (initialize, notifications/initialized, tools/call) plus the standalone SSE GET.
        expect(requests.filter(r => r.method === 'POST')).toHaveLength(3);
        expect(requests.filter(r => r.method === 'GET')).toHaveLength(1);
        for (const req of requests) {
            expect(req.authorization).toBe(`Bearer ${TOKEN}`);
        }

        // token() was consulted once per HTTP request the transport made.
        expect(tokenCalls).toBe(requests.length);

        // The bearer header reached the server intact on the tools/call request.
        expect(authorizationSeenByServer).toEqual([`Bearer ${TOKEN}`]);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:authprovider:onunauthorized-retry', async (_args: TestArgs) => {
    const STALE = 'stale-bearer-token';
    const FRESH = 'fresh-bearer-token';

    // Phase 1: 401 → onUnauthorized refreshes the token → the transport retries once and the request succeeds.
    let currentToken = STALE;
    const unauthorizedCalls: Array<{ status: number; serverUrl: string }> = [];
    const refreshingProvider: AuthProvider = {
        token: async () => currentToken,
        onUnauthorized: async ctx => {
            unauthorizedCalls.push({ status: ctx.response.status, serverUrl: String(ctx.serverUrl) });
            currentToken = FRESH;
        }
    };

    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'ok' }] }));
        return s;
    });

    const postBearers: Array<string | null> = [];
    // Token validity is enforced at the HTTP layer: anything but the fresh token is rejected with 401.
    const guardedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const authorization = new Headers(init?.headers).get('authorization');
        if (init?.method === 'POST') {
            postBearers.push(authorization);
        }
        if (authorization !== `Bearer ${FRESH}`) {
            return new Response(null, { status: 401 });
        }
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: refreshingProvider, fetch: guardedFetch });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'probe', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

        // onUnauthorized was awaited exactly once, with the 401 response and the MCP server URL.
        expect(unauthorizedCalls).toEqual([{ status: 401, serverUrl: MCP_URL }]);

        // Exactly one retry: the rejected initialize, its retry with the fresh token, notifications/initialized, tools/call.
        expect(postBearers).toEqual([`Bearer ${STALE}`, `Bearer ${FRESH}`, `Bearer ${FRESH}`, `Bearer ${FRESH}`]);
    } finally {
        await client.close();
        await mcpHost.close();
    }

    // Phase 2: a provider without onUnauthorized cannot recover, so the 401 surfaces as UnauthorizedError without a retry.
    let tokenOnlyPosts = 0;
    const tokenOnlyProvider: AuthProvider = { token: async () => STALE };
    const alwaysUnauthorizedFetch = async (_url: URL | string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'POST') {
            tokenOnlyPosts += 1;
        }
        return new Response(null, { status: 401 });
    };

    const tokenOnlyClient = new Client({ name: 'c', version: '0' });
    const tokenOnlyTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: tokenOnlyProvider,
        fetch: alwaysUnauthorizedFetch
    });

    try {
        await expect(tokenOnlyClient.connect(tokenOnlyTransport)).rejects.toThrow(UnauthorizedError);
        expect(tokenOnlyPosts).toBe(1);
    } finally {
        await tokenOnlyClient.close();
    }
});

verifies(
    'client-auth:authprovider:onunauthorized-retry',
    async (_args: TestArgs) => {
        const STALE = 'stale-bearer-token';
        const ROTATED = 'rotated-but-still-rejected-token';

        // The provider refreshes on 401 but the resource keeps rejecting: the retry's 401 must surface as UnauthorizedError.
        let currentToken = STALE;
        let unauthorizedCalls = 0;
        const provider: AuthProvider = {
            token: async () => currentToken,
            onUnauthorized: async () => {
                unauthorizedCalls += 1;
                currentToken = ROTATED;
            }
        };

        const postBearers: Array<string | null> = [];
        const alwaysUnauthorizedFetch = async (_url: URL | string, init?: RequestInit): Promise<Response> => {
            if (init?.method === 'POST') {
                postBearers.push(new Headers(init?.headers).get('authorization'));
            }
            return new Response(null, { status: 401 });
        };

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: alwaysUnauthorizedFetch });

        try {
            await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

            // onUnauthorized ran once and the transport retried exactly once before giving up.
            expect(unauthorizedCalls).toBe(1);
            expect(postBearers).toEqual([`Bearer ${STALE}`, `Bearer ${ROTATED}`]);
        } finally {
            await client.close();
        }
    },
    { title: 'second 401 after retry surfaces as UnauthorizedError' }
);

verifies('client-auth:authprovider:oauth-provider-adapted', async (_args: TestArgs) => {
    const ACCESS_TOKEN = 'adapted-oauth-access-token';
    // A full OAuthClientProvider (not the minimal AuthProvider shape) with an access token already stored.
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: ACCESS_TOKEN, token_type: 'Bearer' },
        clientInformation: { client_id: 'adapted-oauth-client' }
    });

    const authorizationSeenByServer: Array<string | null> = [];
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('probe', { inputSchema: z.object({}) }, (_a, ctx) => {
            authorizationSeenByServer.push(ctx.http?.req?.headers.get('authorization') ?? null);
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    });

    const requests: Array<{ method: string; authorization: string | null }> = [];
    const recordingFetch = async (url: URL | string, init?: RequestInit) => {
        requests.push({ method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
        return mcpHost.handleRequest(new Request(url, init));
    };

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: recordingFetch });

    try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'probe', arguments: {} });
        expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

        // The standalone SSE GET is opened fire-and-forget after initialize; wait for it so it is checked too.
        await vi.waitFor(() => expect(requests.some(r => r.method === 'GET')).toBe(true));

        // The provider's stored access_token is the bearer token on every request the transport made.
        expect(requests.filter(r => r.method === 'POST')).toHaveLength(3);
        for (const req of requests) {
            expect(req.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
        }
        expect(authorizationSeenByServer).toEqual([`Bearer ${ACCESS_TOKEN}`]);

        // No interactive auth flow was needed: the stored token was adapted and used as-is.
        expect(provider.redirectedTo).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:auth-helper:result-values', async (_args: TestArgs) => {
    const ISSUED = 'auth-helper-access-token';
    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: ISSUED, token_type: 'Bearer', refresh_token: 'auth-helper-refresh-token' }]
    });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'auth-helper-client' } });
    const fetchFn = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

    // No tokens and no authorization code: the helper starts the redirect flow and reports it with the literal string.
    const redirectResult = await auth(provider, { serverUrl: MCP_URL, fetchFn });
    expect(redirectResult).toBe('REDIRECT');
    expect(provider.redirectedTo).toHaveLength(1);
    const redirect = defined(provider.redirectedTo[0], 'authorization redirect URL');
    expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/authorize`);
    expect(provider.saved.codeVerifier).toBeDefined();
    expect(as.tokenCalls).toHaveLength(0);

    // Completing the code exchange: tokens are persisted and the helper reports success with the literal string.
    const authorizedResult = await auth(provider, { serverUrl: MCP_URL, authorizationCode: 'granted-authorization-code', fetchFn });
    expect(authorizedResult).toBe('AUTHORIZED');
    expect(as.tokenCalls).toHaveLength(1);
    const tokenCall = defined(as.tokenCalls[0], 'token call');
    expect(tokenCall.body.get('grant_type')).toBe('authorization_code');
    expect(tokenCall.body.get('code')).toBe('granted-authorization-code');
    expect(provider.saved.tokens?.access_token).toBe(ISSUED);
});

verifies('client-auth:refresh:typed-errors', async (_args: TestArgs) => {
    // Token endpoint that always rejects with the given RFC 6749 error body.
    const oauthErrorFetch =
        (errorCode: string) =>
        async (_url: URL | string, _init?: RequestInit): Promise<Response> =>
            Response.json({ error: errorCode, error_description: `mock ${errorCode} response` }, { status: 400 });

    // The per-code classes are not exported by v2, so the typed-class contract is asserted via the rejection's constructor name.
    const expectTypedRejection = async (attempt: Promise<unknown>, expectedClassName: string, expectedCode: string) => {
        const rejection: unknown = await attempt.then(
            () => {
                throw new Error('token request unexpectedly resolved');
            },
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(OAuthError);
        if (!(rejection instanceof OAuthError)) throw new Error('expected an OAuthError rejection');
        expect(rejection.name).toBe(expectedClassName);
        expect(rejection.code).toBe(expectedCode);
        expect(rejection.message).toContain(`mock ${expectedCode} response`);
    };

    const clientInformation = { client_id: 'typed-error-client' };

    const refreshCases: Array<{ error: string; expectedClassName: string }> = [
        { error: 'invalid_grant', expectedClassName: 'InvalidGrantError' },
        { error: 'invalid_client', expectedClassName: 'InvalidClientError' },
        { error: 'server_error', expectedClassName: 'ServerError' },
        { error: 'temporarily_unavailable', expectedClassName: 'TemporarilyUnavailableError' }
    ];
    for (const { error, expectedClassName } of refreshCases) {
        await expectTypedRejection(
            refreshAuthorization(ISSUER, {
                clientInformation,
                refreshToken: 'long-lived-refresh-token',
                fetchFn: oauthErrorFetch(error)
            }),
            expectedClassName,
            error
        );
    }

    const exchangeCases: Array<{ error: string; expectedClassName: string }> = [
        { error: 'invalid_grant', expectedClassName: 'InvalidGrantError' },
        { error: 'invalid_client', expectedClassName: 'InvalidClientError' }
    ];
    for (const { error, expectedClassName } of exchangeCases) {
        await expectTypedRejection(
            exchangeAuthorization(ISSUER, {
                clientInformation,
                authorizationCode: 'granted-authorization-code',
                codeVerifier: 'a-code-verifier',
                redirectUri: 'http://localhost:3000/callback',
                fetchFn: oauthErrorFetch(error)
            }),
            expectedClassName,
            error
        );
    }
});

verifies('client-auth:no-tokens:no-auth-header', async (_args: TestArgs) => {
    // Phase 1: tokens() returns undefined — the request goes out with no Authorization header and the 401 re-enters the auth flow.
    const noTokensAs = createMockAuthorizationServer();
    const noTokensProvider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'no-tokens-client' } });
    const noTokensHost = createAuthenticatedHost('token-never-issued');
    const noTokensBaseFetch = createCombinedFetch({ as: noTokensAs, mcpHost: noTokensHost, validToken: 'token-never-issued' });

    const noTokensMcpHeaders: Array<Record<string, string>> = [];
    const noTokensFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin !== ISSUER && !urlObj.pathname.includes('/.well-known/') && init?.method === 'POST') {
            const headers: Record<string, string> = {};
            for (const [k, v] of new Headers(init?.headers).entries()) {
                headers[k] = v;
            }
            noTokensMcpHeaders.push(headers);
        }
        return noTokensBaseFetch(url, init);
    };

    const noTokensClient = new Client({ name: 'c', version: '0' });
    const noTokensTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: noTokensProvider, fetch: noTokensFetch });

    try {
        await expect(noTokensClient.connect(noTokensTransport)).rejects.toThrow(UnauthorizedError);

        // The single unauthenticated POST carried no Authorization header at all.
        expect(noTokensMcpHeaders).toHaveLength(1);
        expect(defined(noTokensMcpHeaders[0], 'unauthenticated POST headers')['authorization']).toBeUndefined();

        // The resulting 401 re-entered the auth flow: the user is redirected to the authorization endpoint.
        expect(noTokensProvider.redirectedTo).toHaveLength(1);
        const noTokensRedirect = defined(noTokensProvider.redirectedTo[0], 'authorization redirect URL');
        expect(noTokensRedirect.origin + noTokensRedirect.pathname).toBe(`${ISSUER}/authorize`);
        expect(noTokensProvider.saved.codeVerifier).toBeDefined();
    } finally {
        await noTokensClient.close();
        await noTokensHost.close();
    }

    // Phase 2: stored tokens lack refresh_token — expiry leads back to the authorization-code flow, never a refresh attempt.
    const noRefreshAs = createMockAuthorizationServer();
    const noRefreshProvider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'expired-access-token', token_type: 'Bearer' },
        clientInformation: { client_id: 'no-refresh-client' }
    });
    const noRefreshHost = createAuthenticatedHost('token-never-issued');
    const noRefreshBaseFetch = createCombinedFetch({ as: noRefreshAs, mcpHost: noRefreshHost, validToken: 'token-never-issued' });

    const noRefreshMcpAuthHeaders: Array<string | null> = [];
    const noRefreshFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin !== ISSUER && !urlObj.pathname.includes('/.well-known/') && init?.method === 'POST') {
            noRefreshMcpAuthHeaders.push(new Headers(init?.headers).get('authorization'));
        }
        return noRefreshBaseFetch(url, init);
    };

    const noRefreshClient = new Client({ name: 'c', version: '0' });
    const noRefreshTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: noRefreshProvider,
        fetch: noRefreshFetch
    });

    try {
        await expect(noRefreshClient.connect(noRefreshTransport)).rejects.toThrow(UnauthorizedError);

        // The expired bearer was sent once, but with no refresh_token there is no token-endpoint call at all (no refresh grant).
        expect(noRefreshMcpAuthHeaders).toEqual(['Bearer expired-access-token']);
        expect(noRefreshAs.tokenCalls).toHaveLength(0);

        // Instead the full authorization-code flow restarts.
        expect(noRefreshProvider.redirectedTo).toHaveLength(1);
        const noRefreshRedirect = defined(noRefreshProvider.redirectedTo[0], 'authorization redirect URL');
        expect(noRefreshRedirect.origin + noRefreshRedirect.pathname).toBe(`${ISSUER}/authorize`);
    } finally {
        await noRefreshClient.close();
        await noRefreshHost.close();
    }
});

verifies('client-transport:sse:401-unauthorized-code', async (_args: TestArgs) => {
    const wwwAuthenticate = `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"`;

    // Phase 1: no authProvider — the 401 surfaces as an SseError carrying the HTTP status code.
    const bareFetch = async (_url: URL | string, _init?: RequestInit): Promise<Response> =>
        new Response(null, { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } });

    const bareTransport = new SSEClientTransport(new URL(MCP_URL), { fetch: bareFetch });
    try {
        const rejection: unknown = await bareTransport.start().then(
            () => {
                throw new Error('start() unexpectedly resolved');
            },
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SseError);
        if (!(rejection instanceof SseError)) throw new Error('expected an SseError rejection');
        expect(rejection.code).toBe(401);
    } finally {
        await bareTransport.close();
    }

    // Phase 2: with an authProvider the same 401 drives the auth flow (redirect + UnauthorizedError), and finishAuth completes the exchange.
    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: 'sse-access-token', token_type: 'Bearer' }]
    });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'sse-client' } });

    const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const urlObj = typeof url === 'string' ? new URL(url) : url;
        if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
            return as.handleRequest(new Request(url, init));
        }
        return new Response(null, { status: 401, headers: { 'WWW-Authenticate': wwwAuthenticate } });
    };

    const authTransport = new SSEClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });
    try {
        await expect(authTransport.start()).rejects.toBeInstanceOf(UnauthorizedError);

        // Same retry semantics as the streamable HTTP transport: the 401 redirected the user to the authorization endpoint.
        expect(provider.redirectedTo).toHaveLength(1);
        const redirect = defined(provider.redirectedTo[0], 'authorization redirect URL');
        expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/authorize`);
        expect(provider.saved.codeVerifier).toBeDefined();

        // finishAuth exchanges the callback code for tokens, mirroring the streamable HTTP transport surface.
        await authTransport.finishAuth('granted-authorization-code');
        expect(as.tokenCalls).toHaveLength(1);
        const tokenCall = defined(as.tokenCalls[0], 'token call');
        expect(tokenCall.body.get('grant_type')).toBe('authorization_code');
        expect(tokenCall.body.get('code')).toBe('granted-authorization-code');
        expect(provider.saved.tokens?.access_token).toBe('sse-access-token');
    } finally {
        await authTransport.close();
    }
});

// --- SEP-837 / SEP-2207 (DCR hygiene) -------------------------------------------------

verifies(['client-auth:dcr:app-type-heuristic', 'client-auth:dcr:grant-types-default'], async (_args: TestArgs) => {
    const as = createMockAuthorizationServer();
    // No application_type, no grant_types in clientMetadata; redirect_uri is loopback.
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('dcr-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'dcr-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        expect(as.registerCalls).toHaveLength(1);
        const body = defined(as.registerCalls[0], 'registration call').body;
        // SEP-837: loopback redirect URI → 'native' by heuristic.
        expect(body.application_type).toBe('native');
        // SEP-2207: omitted grant_types → defaulted to include refresh_token.
        expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies(
    'client-auth:dcr:app-type-heuristic',
    async (_args: TestArgs) => {
        // Heuristic 'web' branch: drive registerClient() with a resolveClientMetadata() result so the
        // test can use a non-loopback redirect URI without going through auth()'s redirectUrl plumbing.
        const as = createMockAuthorizationServer();
        const fetchFn = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

        await registerClient(ISSUER, {
            clientMetadata: resolveClientMetadata({
                clientMetadata: { client_name: 'web-app', redirect_uris: ['https://app.example.com/callback'] },
                redirectUrl: 'https://app.example.com/callback'
            }),
            fetchFn
        });

        expect(as.registerCalls).toHaveLength(1);
        expect(defined(as.registerCalls[0], 'registration call').body.application_type).toBe('web');
    },
    { title: "non-loopback https redirect URI defaults to 'web'" }
);

verifies('client-auth:dcr:app-type-override', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer();
    // Loopback redirect URI but the consumer explicitly says 'web' (e.g. web app dev-served on localhost).
    const provider = new RecordingOAuthClientProvider({ clientMetadata: { application_type: 'web' } });
    const mcpHost = createAuthenticatedHost('dcr-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'dcr-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        expect(as.registerCalls).toHaveLength(1);
        const body = defined(as.registerCalls[0], 'registration call').body;
        expect(body.application_type).toBe('web'); // heuristic would have picked 'native'
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:dcr:grant-types-default', async (_args: TestArgs) => {
    // Consumer-set grant_types is never rewritten.
    const as = createMockAuthorizationServer();
    const fetchFn = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

    await registerClient(ISSUER, {
        clientMetadata: { client_name: 'm2m', redirect_uris: ['http://localhost:3000/cb'], grant_types: ['client_credentials'] },
        fetchFn
    });

    expect(as.registerCalls).toHaveLength(1);
    expect(defined(as.registerCalls[0], 'registration call').body.grant_types).toEqual(['client_credentials']);
});

verifies('client-auth:dcr:registration-rejected-error', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({
        registerErrorResponse: { status: 400, error: 'invalid_redirect_uri', error_description: 'loopback not permitted' }
    });
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('never');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'never' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        const err = await client.connect(transport).catch((error: unknown) => error);

        // Propagates through auth() — not caught by the OAuthError retry path.
        expect(err).toBeInstanceOf(RegistrationRejectedError);
        expect(err).not.toBeInstanceOf(OAuthError);
        const rre = err as RegistrationRejectedError;
        expect(rre.status).toBe(400);
        expect(rre.body).toContain('invalid_redirect_uri');
        // Submitted metadata reflects what was POSTed (after defaults applied) so callers can adjust+retry.
        expect(rre.submittedMetadata.application_type).toBe('native');
        expect(rre.submittedMetadata.redirect_uris).toEqual(['http://localhost:3000/callback']);
        // Exactly one /register call — the auth() recovery path did not silently retry.
        expect(as.registerCalls).toHaveLength(1);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:token-endpoint:https-guard', async (_args: TestArgs) => {
    // AS metadata advertises a non-https, non-loopback token endpoint.
    const as = createMockAuthorizationServer({ asMetadata: { token_endpoint: 'http://auth.example.com/token' } });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'https-guard-client' } });
    provider.saveCodeVerifier('verifier');
    const fetchFn = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

    // Exchange path through auth(): redeeming an authorization code is rejected before the request is sent.
    await expect(auth(provider, { serverUrl: MCP_URL, authorizationCode: 'code', fetchFn })).rejects.toThrow(InsecureTokenEndpointError);
    expect(as.tokenCalls).toHaveLength(0);

    // Refresh path through auth(): a stored refresh_token + non-https token endpoint surfaces the
    // configuration error to the caller — it is NOT swallowed into a silent /authorize redirect.
    const refreshProvider = new RecordingOAuthClientProvider({
        clientInformation: { client_id: 'https-guard-client' },
        tokens: { access_token: 'old', token_type: 'Bearer', refresh_token: 'rt' }
    });
    await expect(auth(refreshProvider, { serverUrl: MCP_URL, fetchFn })).rejects.toThrow(InsecureTokenEndpointError);
    expect(as.tokenCalls).toHaveLength(0);
    expect(refreshProvider.redirectedTo).toHaveLength(0);

    // And the lower-level helper rejects with the same dedicated class.
    await expect(
        refreshAuthorization(ISSUER, {
            metadata: {
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/authorize`,
                token_endpoint: 'http://auth.example.com/token',
                response_types_supported: ['code']
            },
            clientInformation: { client_id: 'https-guard-client' },
            refreshToken: 'rt',
            fetchFn
        })
    ).rejects.toThrow(InsecureTokenEndpointError);
    expect(as.tokenCalls).toHaveLength(0);

    // Loopback exemption: the in-process mock AS itself uses an https issuer; cover the exemption
    // directly so a future tightening of the guard does not silently break local-dev / test setups.
    const loopbackAs = createMockAuthorizationServer({ asMetadata: { token_endpoint: 'http://127.0.0.1:9001/token' } });
    // Route the loopback token URL to the mock.
    const loopbackFetch = (url: URL | string, init?: RequestInit) => loopbackAs.handleRequest(new Request(url, init));
    await expect(
        refreshAuthorization(ISSUER, {
            metadata: {
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/authorize`,
                token_endpoint: 'http://127.0.0.1:9001/token',
                response_types_supported: ['code']
            },
            clientInformation: { client_id: 'https-guard-client' },
            refreshToken: 'rt',
            fetchFn: loopbackFetch
        })
    ).resolves.toBeDefined();
});

verifies('client-auth:refresh:rotation-handling', async (_args: TestArgs) => {
    const clientInformation = { client_id: 'rotation-client', client_secret: 's' };
    const as = createMockAuthorizationServer({
        tokenResponses: [
            { access_token: 'a1', token_type: 'Bearer' }, // no refresh_token issued
            { access_token: 'a2', token_type: 'Bearer' }, // refresh: AS omits refresh_token → keep prior
            { access_token: 'a3', token_type: 'Bearer', refresh_token: 'rt-new' } // refresh: rotated
        ]
    });
    const fetchFn = (url: URL | string, init?: RequestInit) => as.handleRequest(new Request(url, init));

    // No-assume-issuance: token response without refresh_token parses cleanly.
    const t1 = await exchangeAuthorization(ISSUER, {
        clientInformation,
        authorizationCode: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'http://localhost:3000/callback',
        fetchFn
    });
    expect(t1.refresh_token).toBeUndefined();

    // Prior refresh_token preserved when AS omits a replacement.
    const t2 = await refreshAuthorization(ISSUER, { clientInformation, refreshToken: 'rt-old', fetchFn });
    expect(t2.refresh_token).toBe('rt-old');

    // Rotated refresh_token adopted when AS returns one.
    const t3 = await refreshAuthorization(ISSUER, { clientInformation, refreshToken: 'rt-old', fetchFn });
    expect(t3.refresh_token).toBe('rt-new');
});

verifies('client-auth:scope:offline-access-gate', async (_args: TestArgs) => {
    // AS advertises offline_access; provider explicitly sets grant_types including refresh_token,
    // so offline_access is appended to the requested scope on authorize.
    const asWith = createMockAuthorizationServer({ asMetadata: { scopes_supported: ['openid', 'offline_access'] } });
    const providerWith = new RecordingOAuthClientProvider({
        clientMetadata: { grant_types: ['authorization_code', 'refresh_token'] }
    });
    const fetchWith = createCombinedFetch({ as: asWith, mcpHost: createAuthenticatedHost('never'), validToken: 'never' });

    await auth(providerWith, { serverUrl: MCP_URL, fetchFn: fetchWith });

    const redirectWith = defined(providerWith.redirectedTo[0], 'authorization redirect URL');
    expect(redirectWith.searchParams.get('scope')?.split(' ')).toContain('offline_access');

    // AS does NOT advertise offline_access → never appended.
    const asWithout = createMockAuthorizationServer({ asMetadata: { scopes_supported: ['openid'] } });
    const providerWithout = new RecordingOAuthClientProvider();
    const fetchWithout = createCombinedFetch({ as: asWithout, mcpHost: createAuthenticatedHost('never'), validToken: 'never' });

    await auth(providerWithout, { serverUrl: MCP_URL, fetchFn: fetchWithout });

    const redirectWithout = defined(providerWithout.redirectedTo[0], 'authorization redirect URL');
    expect((redirectWithout.searchParams.get('scope') ?? '').split(' ')).not.toContain('offline_access');
});
