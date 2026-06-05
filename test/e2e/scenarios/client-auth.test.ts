/**
 * Self-contained test bodies for the client-auth surface (OAuth client flows + middleware).
 *
 * All tests use streamableHttp transport. A reusable mock Authorization Server
 * (routing function) handles discovery, DCR, and token exchange; a recording
 * OAuthClientProvider tracks state transitions and SDK calls.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { LATEST_PROTOCOL_VERSION, type IsomorphicHeaders } from '../../../src/types.js';

import { importSPKI, jwtVerify } from 'jose';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import {
    auth,
    discoverAuthorizationServerMetadata,
    discoverOAuthProtectedResourceMetadata,
    exchangeAuthorization,
    OAuthClientProvider,
    refreshAuthorization,
    startAuthorization,
    UnauthorizedError
} from '../../../src/client/auth.js';
import { applyMiddlewares, createMiddleware, withLogging, withOAuth } from '../../../src/client/middleware.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '../../../src/client/streamableHttp.js';
import { SSEClientTransport, SseError } from '../../../src/client/sse.js';
import { ClientCredentialsProvider, PrivateKeyJwtProvider, StaticPrivateKeyJwtProvider } from '../../../src/client/auth-extensions.js';
import { McpServer } from '../../../src/server/mcp.js';
import {
    InvalidClientError,
    InvalidGrantError,
    OAuthError,
    ServerError,
    TemporarilyUnavailableError
} from '../../../src/server/auth/errors.js';
import {
    AuthorizationServerMetadata,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthTokens
} from '../../../src/shared/auth.js';

import { hostPerSession } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const ISSUER = 'https://auth.example.com';
const MCP_URL = 'http://in-process/mcp';
const RESOURCE = 'http://in-process/mcp';

interface MockASConfig {
    tokenResponses?: Array<Partial<OAuthTokens>>;
    tokenErrorResponses?: Array<{ error: string; error_description?: string }>;
    registerResponse?: Partial<OAuthClientInformationFull>;
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
    const registerCalls: Array<{ body: Record<string, unknown>; url: string }> = [];
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
            return new Response(JSON.stringify(prmMetadata), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (path.includes('/.well-known/oauth-authorization-server') || path.includes('/.well-known/openid-configuration')) {
            discoveryCalls.push(path);
            if (config.noASDiscovery) {
                return new Response('Not Found', { status: 404 });
            }
            return new Response(JSON.stringify(asMetadata), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Endpoints are matched against the advertised metadata (not hardcoded defaults) so tests can
        // serve non-default paths and prove the SDK uses the *discovered* endpoints rather than fallbacks.
        if (path === new URL(asMetadata.authorization_endpoint).pathname) {
            authorizeCalls.push({ url, params: new URLSearchParams(url.search) });
            return new Response('Authorization page', { status: 200 });
        }

        if (path === new URL(asMetadata.token_endpoint).pathname && req.method === 'POST') {
            const bodyText = await req.text();
            const body = new URLSearchParams(bodyText);
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => {
                headers[k] = v;
            });
            tokenCalls.push({ method: req.method, headers, body });

            if (config.tokenErrorResponses && tokenErrorIndex < config.tokenErrorResponses.length) {
                const err = config.tokenErrorResponses[tokenErrorIndex++];
                return new Response(JSON.stringify(err), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const response = config.tokenResponses?.[tokenIndex++] ?? { access_token: 'mock-token', token_type: 'Bearer' };
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (asMetadata.registration_endpoint && path === new URL(asMetadata.registration_endpoint).pathname && req.method === 'POST') {
            const body: Record<string, unknown> = await req.json();
            registerCalls.push({ body, url: req.url });
            // RFC 7591: the registration response echoes the submitted metadata plus issued credentials.
            const response = {
                ...body,
                client_id: 'registered-client-id',
                client_secret: 'registered-client-secret',
                token_endpoint_auth_method: 'client_secret_basic',
                ...config.registerResponse
            };
            return new Response(JSON.stringify(response), {
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

    get clientMetadata() {
        return {
            client_name: 'Test Client',
            redirect_uris: [this.redirectUrl]
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
        s.registerTool('probe', { inputSchema: z.object({}) }, (_args, extra) => {
            if (extra.authInfo?.token !== validToken) {
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
        expect(provider.redirectedTo[0].origin).toBe(ISSUER);
        expect(provider.redirectedTo[0].pathname).toBe('/authorize');
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
        await expect(connectPromise).rejects.toBeInstanceOf(StreamableHTTPError);
        await expect(connectPromise).rejects.toThrow(/401 after successful authentication/);

        // Auth ran exactly once (refresh grant), and the transport stopped after one retry instead of looping.
        expect(as.tokenCalls).toHaveLength(1);
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');
        expect(as.tokenCalls[0].body.get('refresh_token')).toBe('stale-refresh-token');
        expect(mcpPosts).toHaveLength(2);
        expect(provider.redirectedTo).toHaveLength(0);
    } finally {
        await client.close();
    }
});

verifies(
    'client-auth:401-after-auth-throws',
    async (_args: TestArgs) => {
        // GET arm, interactive client: the standalone SSE GET is rejected with 401 while POSTs succeed.
        // The auth flow runs once; a REDIRECT outcome surfaces as an error instead of re-opening the GET.
        const as = createMockAuthorizationServer();
        const provider = new RecordingOAuthClientProvider({
            tokens: { access_token: 'stale-access-token', token_type: 'Bearer' },
            clientInformation: { client_id: 'pre-registered-client' }
        });
        const mcpHost = hostPerSession(() => new McpServer({ name: 's', version: '0' }));

        const mcpGets: string[] = [];
        // POSTs are accepted so connect() succeeds; only the standalone GET /mcp SSE open keeps 401ing.
        const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return as.handleRequest(new Request(url, init));
            }
            if (init?.method === 'GET') {
                mcpGets.push(urlObj.pathname);
                return new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"` }
                });
            }
            return mcpHost.handleRequest(new Request(url, init));
        };

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        const surfacedErrors: Error[] = [];
        client.onerror = e => {
            surfacedErrors.push(e);
        };
        try {
            await client.connect(transport);

            await vi.waitFor(() => expect(surfacedErrors.length).toBeGreaterThan(0), { timeout: 5000 });

            // Exactly one GET was attempted; its 401 entered the auth flow once (no refresh token, so
            // it goes interactive), and the REDIRECT outcome surfaced as an error — no GET retry loop.
            expect(mcpGets).toHaveLength(1);
            expect(provider.redirectedTo).toHaveLength(1);
            expect(as.tokenCalls).toHaveLength(0);
            expect(surfacedErrors[0]).toBeInstanceOf(UnauthorizedError);
        } finally {
            await client.close();
            await mcpHost.close();
        }
    },
    { title: 'standalone GET 401 redirect' }
);

verifies(
    'client-auth:401-after-auth-throws',
    async (_args: TestArgs) => {
        // GET arm, caching client: every successful refresh re-opens the standalone SSE GET, which the
        // server keeps rejecting with 401. The client must stop after one post-auth retry instead of
        // looping for as long as the refresh grant keeps succeeding (and it succeeds indefinitely:
        // the SDK preserves the prior refresh token whenever the token response omits one).
        const as = createMockAuthorizationServer();
        const provider = new RecordingOAuthClientProvider({
            tokens: { access_token: 'stale-access-token', token_type: 'Bearer', refresh_token: 'rt-1' },
            clientInformation: { client_id: 'pre-registered-client' }
        });
        const mcpHost = hostPerSession(() => new McpServer({ name: 's', version: '0' }));

        const mcpGets: string[] = [];
        const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                // Degrade the token endpoint after three refreshes so the cycle observably terminates;
                // without this cap a looping client would refresh successfully forever.
                if (urlObj.pathname === '/token' && as.tokenCalls.length >= 3) {
                    return new Response(JSON.stringify({ error: 'server_error', error_description: 'token endpoint degraded' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return as.handleRequest(new Request(url, init));
            }
            if (init?.method === 'GET') {
                mcpGets.push(urlObj.pathname);
                return new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"` }
                });
            }
            return mcpHost.handleRequest(new Request(url, init));
        };

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        const surfacedErrors: Error[] = [];
        client.onerror = e => {
            surfacedErrors.push(e);
        };
        try {
            await client.connect(transport);

            await vi.waitFor(() => expect(surfacedErrors.length).toBeGreaterThan(0), { timeout: 5000 });

            // One initial GET plus at most one post-auth retry; the second 401 must surface an error
            // rather than running another refresh + GET cycle.
            expect(mcpGets.length).toBeLessThanOrEqual(2);
        } finally {
            await client.close();
            await mcpHost.close();
        }
    },
    { title: 'standalone GET 401 refresh loop' }
);

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
        expect(interactiveProvider.redirectedTo[0].searchParams.get('scope')).toBe(UPGRADED_SCOPE);
        expect(interactiveMcpRequests).toHaveLength(1);
    } finally {
        await interactiveClient.close();
    }

    // Phase 2: when the upscoped token is still rejected with the same header, the transport stops instead of looping.
    const refreshAs = createMockAuthorizationServer({
        tokenResponses: [{ access_token: 'upscoped-access-token', token_type: 'Bearer' }]
    });
    const refreshProvider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'narrow-scope-token', token_type: 'Bearer', refresh_token: 'narrow-refresh-token' },
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
        await expect(connectPromise).rejects.toBeInstanceOf(StreamableHTTPError);
        await expect(connectPromise).rejects.toThrow(/403 after trying upscoping/);

        expect(refreshAs.tokenCalls).toHaveLength(1);
        expect(refreshAs.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');
        expect(refreshAs.tokenCalls[0].body.get('refresh_token')).toBe('narrow-refresh-token');
        // Mechanism pin, not an endorsement: on insufficient_scope a caching client prefers the
        // refresh grant, and the refresh /token body is built WITHOUT the challenged scope (no scope
        // param at all) — so the "upscoped" token can never actually be broader. This is the same gap
        // the 'refresh-token scope' knownFailure arm asserts from the spec side; when the SDK starts
        // threading the challenge scope into the refresh body, that arm flips red and these two
        // absence assertions must be dropped together with it.
        expect(refreshAs.tokenCalls[0].body.get('scope')).toBeNull();
        expect([...refreshAs.tokenCalls[0].body.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token', 'resource']);
        expect(refreshMcpRequests).toHaveLength(2);
    } finally {
        await refreshClient.close();
    }
});

verifies(
    'client-auth:403-scope-upgrade',
    async (_args: TestArgs) => {
        // Refresh arm of the scope upgrade: a caching client (refresh token on hand) answering a 403
        // insufficient_scope challenge must carry the upgraded scope set on the refresh-token grant —
        // otherwise the "upscoped" token it receives is never actually broader.
        const UPGRADED_SCOPE = 'mcp:read mcp:write mcp:admin';
        const insufficientScopeHeader = `Bearer error="insufficient_scope", scope="${UPGRADED_SCOPE}", resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"`;

        const as = createMockAuthorizationServer({
            tokenResponses: [{ access_token: 'upscoped-access-token', token_type: 'Bearer' }]
        });
        const provider = new RecordingOAuthClientProvider({
            tokens: { access_token: 'narrow-scope-token', token_type: 'Bearer', refresh_token: 'narrow-refresh-token' },
            clientInformation: { client_id: 'pre-registered-client' }
        });

        const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return as.handleRequest(new Request(url, init));
            }
            return new Response(null, { status: 403, headers: { 'WWW-Authenticate': insufficientScopeHeader } });
        };

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        try {
            await expect(client.connect(transport)).rejects.toThrow();

            expect(as.tokenCalls).toHaveLength(1);
            expect(as.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');
            // The upgraded scope parsed from the WWW-Authenticate challenge must reach the /token body.
            expect(as.tokenCalls[0].body.get('scope')).toBe(UPGRADED_SCOPE);
        } finally {
            await client.close();
        }
    },
    { title: 'refresh-token scope' }
);

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
                return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
        await expect(client.connect(transport)).rejects.toThrow(/issuer/i);

        // The mismatched metadata is rejected before registering, redirecting the user, or requesting tokens.
        expect(as.registerCalls).toHaveLength(0);
        expect(provider.redirectedTo).toHaveLength(0);
        expect(as.tokenCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
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
        new Headers(init?.headers).forEach((v, k) => {
            headers[k] = v;
        });
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
        expect(provider.redirectedTo[0].searchParams.get('client_id')).toBe(cimdUrl);
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
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('client_credentials');
        const basicHeader = as.tokenCalls[0].headers['authorization'];
        expect(basicHeader).toMatch(/^Basic /);
        expect(Buffer.from(basicHeader.split(' ')[1], 'base64').toString()).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);

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
    // The registration endpoint lives at a NON-default path: an SDK that hardcodes /register
    // (instead of using the discovered registration_endpoint) gets a 404 and the flow fails.
    const as = createMockAuthorizationServer({ asMetadata: { registration_endpoint: `${ISSUER}/oauth2/dcr` } });
    const provider = new RecordingOAuthClientProvider();
    const mcpHost = createAuthenticatedHost('dcr-token');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'dcr-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // No client_id was preconfigured, so the SDK must register at the *discovered* registration endpoint.
        expect(as.registerCalls).toHaveLength(1);
        expect(new URL(as.registerCalls[0].url).pathname).toBe('/oauth2/dcr');
        expect(as.registerCalls[0].body.client_name).toBe('Test Client');
        expect(as.registerCalls[0].body.redirect_uris).toContain('http://localhost:3000/callback');

        // The issued client_id is persisted and used for the authorization request.
        expect(provider.saved.clientInformation?.client_id).toBe('registered-client-id');
        expect(provider.redirectedTo).toHaveLength(1);
        expect(provider.redirectedTo[0].searchParams.get('client_id')).toBe('registered-client-id');
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
            expect(as.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');

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
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');

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

verifies(
    'client-auth:invalid-grant-clears-tokens',
    async (_args: TestArgs) => {
        // Authorization-code arm: invalid_grant can also surface from the code exchange (RFC 6749 §5.2,
        // expired/reused code), not just the refresh grant. The same invalidation rule applies.
        const as = createMockAuthorizationServer({
            tokenErrorResponses: [
                { error: 'invalid_grant', error_description: 'Authorization code expired' },
                { error: 'invalid_grant', error_description: 'Authorization code expired' }
            ]
        });
        const provider = new RecordingOAuthClientProvider({
            clientInformation: { client_id: 'still-valid-client' }
        });
        const mcpHost = createAuthenticatedHost('token-never-issued');
        const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        try {
            // First connect starts the interactive flow (saves the code verifier finishAuth needs).
            await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);
            expect(provider.redirectedTo).toHaveLength(1);

            // The exchange fails with invalid_grant; after invalidating tokens the error-driven retry
            // re-attempts the exchange once (second token call), whose invalid_grant then propagates typed.
            await expect(transport.finishAuth('expired-authorization-code')).rejects.toBeInstanceOf(InvalidGrantError);

            expect(as.tokenCalls).toHaveLength(2);
            for (const call of as.tokenCalls) {
                expect(call.body.get('grant_type')).toBe('authorization_code');
                expect(call.body.get('code')).toBe('expired-authorization-code');
            }

            // Only tokens are invalidated; the client registration is kept (no re-registration).
            expect(provider.invalidatedCredentials).toEqual(['tokens']);
            expect(provider.saved.tokens).toBeUndefined();
            expect(provider.saved.clientInformation?.client_id).toBe('still-valid-client');
            expect(as.registerCalls).toHaveLength(0);
        } finally {
            await client.close();
            await mcpHost.close();
        }
    },
    { title: 'authorization-code exchange' }
);

verifies('typescript:client-auth:refresh:server-error-fallback', async (_args: TestArgs) => {
    // A transient token-endpoint failure (server_error) during refresh is swallowed: auth() falls
    // back to a fresh interactive authorization WITHOUT invalidating any stored credentials. Typed
    // errors with their own handling (invalid_grant, invalid_client) are covered by their own cells.
    const as = createMockAuthorizationServer({
        tokenErrorResponses: [{ error: 'server_error', error_description: 'AS temporarily broken' }]
    });
    const provider = new RecordingOAuthClientProvider({
        tokens: { access_token: 'stale-access-token', token_type: 'Bearer', refresh_token: 'transient-refresh-token' },
        clientInformation: { client_id: 'resilient-client' }
    });
    const mcpHost = createAuthenticatedHost('token-never-issued');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // Exactly one refresh attempt surfaced the server_error.
        expect(as.tokenCalls).toHaveLength(1);
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');

        // The failure was swallowed, not escalated: nothing is invalidated, the stored token set
        // (including the refresh token) is kept, and the flow falls through to the redirect.
        expect(provider.invalidatedCredentials).toEqual([]);
        expect(provider.saved.tokens?.refresh_token).toBe('transient-refresh-token');
        expect(provider.saved.clientInformation?.client_id).toBe('resilient-client');
        expect(provider.redirectedTo).toHaveLength(1);
        expect(as.registerCalls).toHaveLength(0);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:pkce:refuse-if-unsupported', async (_args: TestArgs) => {
    // The refusal must key on "S256 absent from a present list", not on one particular shape:
    // only-plain, an empty list, and lowercase 's256' (the comparison is exact) must all refuse.
    for (const methods of [['plain'], [], ['s256']]) {
        const as = createMockAuthorizationServer({ asMetadata: { code_challenge_methods_supported: methods } });
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
    }
});

verifies(
    'client-auth:pkce:refuse-if-unsupported',
    async (_args: TestArgs) => {
        // Spec 2025-11-25 (authorization-code protection): the client must also refuse when the AS
        // metadata omits code_challenge_methods_supported entirely — absence is not S256 support.
        const as = createMockAuthorizationServer({ asMetadata: { code_challenge_methods_supported: undefined } });
        const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'pkce-strict-client' } });
        const mcpHost = createAuthenticatedHost('token-never-issued');
        const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        try {
            await expect(client.connect(transport)).rejects.toThrow();

            // The flow stops before any user redirect or token request.
            expect(provider.redirectedTo).toHaveLength(0);
            expect(as.authorizeCalls).toHaveLength(0);
            expect(as.tokenCalls).toHaveLength(0);
        } finally {
            await client.close();
            await mcpHost.close();
        }
    },
    { title: 'absent methods field' }
);

verifies('client-auth:pkce:s256', async (_args: TestArgs) => {
    const as = createMockAuthorizationServer({ tokenResponses: [{ access_token: 'pkce-token', token_type: 'Bearer' }] });
    const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'pkce-client' } });
    const mcpHost = createAuthenticatedHost('pkce-token');

    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'pkce-token' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        const authorizeUrl = provider.redirectedTo[0];
        expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
        const challenge = authorizeUrl.searchParams.get('code_challenge');
        expect(challenge).toBeTruthy();

        const verifier = provider.saved.codeVerifier!;
        expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
        const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
        expect(challenge).toBe(expectedChallenge);

        await transport.finishAuth('mock-code');
        expect(as.tokenCalls).toHaveLength(1);
        expect(as.tokenCalls[0].body.get('code_verifier')).toBe(verifier);
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
        expect(provider.redirectedTo[0].origin).toBe(ISSUER);
        expect(provider.redirectedTo[0].pathname).toBe('/authorize');
        expect(provider.redirectedTo[0].searchParams.get('client_id')).toBe('pre-registered-client');

        // The token exchange authenticates with the preconfigured secret.
        await transport.finishAuth('granted-authorization-code');
        expect(as.tokenCalls).toHaveLength(1);
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('authorization_code');
        const basicHeader = as.tokenCalls[0].headers['authorization'];
        expect(basicHeader).toMatch(/^Basic /);
        expect(Buffer.from(basicHeader.split(' ')[1], 'base64').toString()).toBe('pre-registered-client:pre-registered-secret');
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
        const body = as.tokenCalls[0].body;
        expect(body.get('grant_type')).toBe('client_credentials');
        expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

        // The client authenticates with a JWT signed by its private key — no shared secret anywhere.
        expect(body.get('client_secret')).toBeNull();
        expect(as.tokenCalls[0].headers['authorization']).toBeUndefined();

        const assertion = body.get('client_assertion');
        expect(assertion).toBeTruthy();
        const verificationKey = await importSPKI(publicKeyPem, 'RS256');
        const { payload } = await jwtVerify(assertion!, verificationKey);
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
            return new Response(JSON.stringify(prmMetadata), {
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

verifies(
    'client-auth:prm-discovery:fallback-order',
    async (_args: TestArgs) => {
        // Header branch: when the 401's WWW-Authenticate carries resource_metadata, that exact URL is
        // fetched and the well-known fallback locations are never probed. The PRM responder would
        // answer at ANY oauth-protected-resource path, so only the recorded probe list distinguishes
        // an SDK that honors the header from one that silently default-probes.
        const HEADER_PRM_PATH = '/.well-known/oauth-protected-resource/from-header';
        const as = createMockAuthorizationServer();
        const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'header-prm-client' } });

        const prmProbes: string[] = [];
        const combinedFetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.pathname.includes('/.well-known/oauth-protected-resource')) {
                prmProbes.push(urlObj.pathname);
            }
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return as.handleRequest(new Request(url, init));
            }
            return new Response(null, {
                status: 401,
                headers: { 'WWW-Authenticate': `Bearer resource_metadata="${new URL(MCP_URL).origin}${HEADER_PRM_PATH}"` }
            });
        };

        const client = new Client({ name: 'c', version: '0' });
        const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

        try {
            await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

            // Exactly one PRM fetch, at the header-provided URL — neither the path-aware nor the
            // root well-known location is probed.
            expect(prmProbes).toEqual([HEADER_PRM_PATH]);

            // The flow proceeded on the header-discovered PRM (its AS drives the redirect).
            expect(provider.redirectedTo).toHaveLength(1);
            expect(provider.redirectedTo[0].origin).toBe(ISSUER);
        } finally {
            await client.close();
        }
    },
    { title: 'header resource_metadata wins' }
);

verifies('client-auth:prm-discovery:no-prm-fallback', async (_args: TestArgs) => {
    const VALID = 'legacy-fallback-token';
    const as = createMockAuthorizationServer({
        noPRMDiscovery: true,
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
        expect(provider.redirectedTo[0].origin + provider.redirectedTo[0].pathname).toBe(`${ISSUER}/authorize`);
        expect(provider.redirectedTo[0].searchParams.get('client_id')).toBe('legacy-fallback-client');

        // The same origin-discovered metadata drives the code exchange at the AS token endpoint.
        await transport.finishAuth('granted-authorization-code');
        expect(as.tokenCalls).toHaveLength(1);
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('authorization_code');
        expect(as.tokenCalls[0].body.get('code')).toBe('granted-authorization-code');
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

verifies(
    'client-auth:prm-resource-mismatch',
    async (_args: TestArgs) => {
        // The match is path-aware prefix matching, not an origin comparison.
        // Phase 1: same origin but a non-prefix path must still be refused.
        const mismatchAs = createMockAuthorizationServer({
            prmMetadata: { resource: `${new URL(MCP_URL).origin}/wrong-tenant/mcp` }
        });
        const mismatchProvider = new RecordingOAuthClientProvider();
        const mismatchHost = createAuthenticatedHost('token-never-issued');
        const mismatchFetch = createCombinedFetch({ as: mismatchAs, mcpHost: mismatchHost, validToken: 'token-never-issued' });

        const mismatchClient = new Client({ name: 'c', version: '0' });
        const mismatchTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
            authProvider: mismatchProvider,
            fetch: mismatchFetch
        });

        try {
            await expect(mismatchClient.connect(mismatchTransport)).rejects.toThrow(/resource.*does not match/i);

            expect(mismatchAs.registerCalls).toHaveLength(0);
            expect(mismatchProvider.redirectedTo).toHaveLength(0);
            expect(mismatchAs.tokenCalls).toHaveLength(0);
        } finally {
            await mismatchClient.close();
            await mismatchHost.close();
        }

        // Phase 2: a PRM resource that is a path PREFIX of the server URL is accepted, and the flow
        // proceeds requesting that broader resource (the metadata value, not the server URL).
        const parentResource = `${new URL(MCP_URL).origin}/`;
        const parentAs = createMockAuthorizationServer({ prmMetadata: { resource: parentResource } });
        const parentProvider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'parent-resource-client' } });
        const parentHost = createAuthenticatedHost('token-never-issued');
        const parentFetch = createCombinedFetch({ as: parentAs, mcpHost: parentHost, validToken: 'token-never-issued' });

        const parentClient = new Client({ name: 'c', version: '0' });
        const parentTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: parentProvider, fetch: parentFetch });

        try {
            await expect(parentClient.connect(parentTransport)).rejects.toThrow(UnauthorizedError);

            expect(parentProvider.redirectedTo).toHaveLength(1);
            expect(parentProvider.redirectedTo[0].searchParams.get('resource')).toBe(parentResource);
        } finally {
            await parentClient.close();
            await parentHost.close();
        }
    },
    { title: 'path matching' }
);

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
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');
        expect(as.tokenCalls[0].body.get('refresh_token')).toBe('long-lived-refresh-token');
        expect(as.tokenCalls[0].body.get('resource')).toBe(RESOURCE);

        // The refresh is transparent (no user-facing redirect, no re-registration of the stored client)
        // and the rotated token set is persisted.
        expect(provider.redirectedTo).toHaveLength(0);
        expect(as.registerCalls).toHaveLength(0);
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

        const authorizeUrl = provider.redirectedTo[0];
        expect(authorizeUrl.searchParams.get('resource')).toBe(RESOURCE);

        await transport.finishAuth('mock-code');
        expect(as.tokenCalls[0].body.get('resource')).toBe(RESOURCE);
    } finally {
        await client.close();
        await mcpHost.close();
    }
});

verifies('client-auth:scope-selection:priority', async (_args: TestArgs) => {
    // The precedence is only proven when the lower tiers are LIVE: every arm serves a fetchable PRM
    // (and asserts it was fetched), so the challenge-scope arm beats a real scopes_supported value,
    // the fallback arm joins ALL of a multi-element scopes_supported, and the omit arm drops the
    // param only because no source supplies one.
    const cases: Array<{ challengeScope?: string; prmScopes?: string[]; expected: string | null }> = [
        { challengeScope: 'mcp:custom', prmScopes: ['prm:alpha', 'prm:beta'], expected: 'mcp:custom' },
        { prmScopes: ['prm:alpha', 'prm:beta'], expected: 'prm:alpha prm:beta' },
        { expected: null }
    ];

    for (const { challengeScope, prmScopes, expected } of cases) {
        const as = createMockAuthorizationServer({ prmMetadata: { scopes_supported: prmScopes } });
        const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: 'scope-client' } });
        const mcpHost = createAuthenticatedHost('token-never-issued');

        const scopeAttr = challengeScope === undefined ? '' : ` scope="${challengeScope}"`;
        const combinedFetch = (url: URL | string, init?: RequestInit) => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return Promise.resolve(as.handleRequest(new Request(url, init)));
            }
            const h = new Headers(init?.headers);
            if (!h.has('authorization')) {
                return Promise.resolve(
                    new Response(null, {
                        status: 401,
                        headers: {
                            'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"${scopeAttr}`
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

            // The PRM document was actually retrieved — the lower tier was live, not unreachable.
            expect(as.discoveryCalls.some(p => p.includes('/.well-known/oauth-protected-resource'))).toBe(true);

            const authorizeUrl = provider.redirectedTo[0];
            expect(authorizeUrl.searchParams.get('scope')).toBe(expected);
        } finally {
            await client.close();
            await mcpHost.close();
        }
    }
});

verifies('typescript:client-auth:scope-selection:client-metadata-fallback', async (_args: TestArgs) => {
    // SEP-835 tier 3: when neither the WWW-Authenticate challenge nor the PRM document supplies a
    // scope, the scope configured on clientMetadata is the fallback, and the same resolved value is
    // used consistently for the authorization request and dynamic client registration.
    const CONFIGURED_SCOPE = 'configured:read configured:write';

    class ScopedMetadataProvider extends RecordingOAuthClientProvider {
        override get clientMetadata() {
            return { ...super.clientMetadata, scope: CONFIGURED_SCOPE };
        }
    }

    const as = createMockAuthorizationServer({ prmMetadata: { scopes_supported: undefined } });
    const provider = new ScopedMetadataProvider();
    const mcpHost = createAuthenticatedHost('token-never-issued');
    const combinedFetch = createCombinedFetch({ as, mcpHost, validToken: 'token-never-issued' });

    const client = new Client({ name: 'c', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider, fetch: combinedFetch });

    try {
        await expect(client.connect(transport)).rejects.toThrow(UnauthorizedError);

        // The PRM was live but scope-less, so clientMetadata.scope is the only source.
        expect(as.discoveryCalls.some(p => p.includes('/.well-known/oauth-protected-resource'))).toBe(true);

        // DCR carried the resolved scope, and the authorization request used the same value.
        expect(as.registerCalls).toHaveLength(1);
        expect(as.registerCalls[0].body.scope).toBe(CONFIGURED_SCOPE);
        expect(provider.redirectedTo).toHaveLength(1);
        expect(provider.redirectedTo[0].searchParams.get('scope')).toBe(CONFIGURED_SCOPE);
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
        const authorizeUrl = provider.redirectedTo[0];
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
            const tokenCall = as.tokenCalls[0];
            expect(tokenCall.body.get('grant_type')).toBe('authorization_code');

            if (method === 'client_secret_basic') {
                const authHeader = tokenCall.headers['authorization'];
                expect(authHeader).toMatch(/^Basic /);
                expect(Buffer.from(authHeader.split(' ')[1], 'base64').toString()).toBe(`${REGISTERED_ID}:${REGISTERED_SECRET}`);
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
    // The AS serves NON-default endpoint paths, so the helpers only succeed if they use the
    // discovered metadata — an SDK falling back to the hardcoded /authorize and /token 404s.
    const as = createMockAuthorizationServer({
        tokenResponses: [{ access_token: 'low-level-access-token', token_type: 'Bearer' }],
        asMetadata: {
            authorization_endpoint: `${ISSUER}/oauth2/auth`,
            token_endpoint: `${ISSUER}/oauth2/token`
        }
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
    expect(asMetadata.authorization_endpoint).toBe(`${ISSUER}/oauth2/auth`);
    expect(asMetadata.token_endpoint).toBe(`${ISSUER}/oauth2/token`);

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
    const tokenBody = as.tokenCalls[0].body;
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
        const body = as.tokenCalls[0].body;
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

    const seenByServer: IsomorphicHeaders[] = [];
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('report-headers', { inputSchema: z.object({}) }, (_a, extra) => {
            seenByServer.push(extra.requestInfo?.headers ?? {});
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    });

    const baseRequests: Array<{ method: string; headers: Record<string, string> }> = [];
    const baseFetch = async (url: URL | string, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
            headers[k] = v;
        });
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
        expect(seenByServer[0]['x-mw-first']).toBe('1');
        expect(seenByServer[0]['x-mw-second']).toBe('1');
        expect(seenByServer[0][TRACE]).toBe('second>first');
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
        expect(refreshAs.tokenCalls[0].body.get('grant_type')).toBe('refresh_token');
        expect(refreshAs.tokenCalls[0].body.get('refresh_token')).toBe('initial-refresh-token');

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
    expect(provider.redirectedTo[0].origin + provider.redirectedTo[0].pathname).toBe(`${ISSUER}/authorize`);
    expect(provider.saved.codeVerifier).toBeDefined();
    expect(as.tokenCalls).toHaveLength(0);

    // Completing the code exchange: tokens are persisted and the helper reports success with the literal string.
    const authorizedResult = await auth(provider, { serverUrl: MCP_URL, authorizationCode: 'granted-authorization-code', fetchFn });
    expect(authorizedResult).toBe('AUTHORIZED');
    expect(as.tokenCalls).toHaveLength(1);
    expect(as.tokenCalls[0].body.get('grant_type')).toBe('authorization_code');
    expect(as.tokenCalls[0].body.get('code')).toBe('granted-authorization-code');
    expect(provider.saved.tokens?.access_token).toBe(ISSUED);
});

verifies('client-auth:refresh:typed-errors', async (_args: TestArgs) => {
    // Token endpoint that always rejects with the given RFC 6749 error body.
    const oauthErrorFetch =
        (error: string) =>
        async (_url: URL | string, _init?: RequestInit): Promise<Response> =>
            new Response(JSON.stringify({ error, error_description: `mock ${error} response` }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });

    const expectTypedRejection = async (attempt: Promise<unknown>, expectedClass: typeof OAuthError, expectedCode: string) => {
        const rejection: unknown = await attempt.then(
            () => {
                throw new Error('token request unexpectedly resolved');
            },
            (e: unknown) => e
        );
        expect(rejection).toBeInstanceOf(expectedClass);
        if (!(rejection instanceof OAuthError)) throw new Error('expected an OAuthError rejection');
        expect(rejection.errorCode).toBe(expectedCode);
        expect(rejection.message).toContain(`mock ${expectedCode} response`);
    };

    const clientInformation = { client_id: 'typed-error-client' };

    const refreshCases: Array<{ error: string; expectedClass: typeof OAuthError }> = [
        { error: 'invalid_grant', expectedClass: InvalidGrantError },
        { error: 'invalid_client', expectedClass: InvalidClientError },
        { error: 'server_error', expectedClass: ServerError },
        { error: 'temporarily_unavailable', expectedClass: TemporarilyUnavailableError }
    ];
    for (const { error, expectedClass } of refreshCases) {
        await expectTypedRejection(
            refreshAuthorization(ISSUER, {
                clientInformation,
                refreshToken: 'long-lived-refresh-token',
                fetchFn: oauthErrorFetch(error)
            }),
            expectedClass,
            error
        );
    }

    const exchangeCases: Array<{ error: string; expectedClass: typeof OAuthError }> = [
        { error: 'invalid_grant', expectedClass: InvalidGrantError },
        { error: 'invalid_client', expectedClass: InvalidClientError }
    ];
    for (const { error, expectedClass } of exchangeCases) {
        await expectTypedRejection(
            exchangeAuthorization(ISSUER, {
                clientInformation,
                authorizationCode: 'granted-authorization-code',
                codeVerifier: 'a-code-verifier',
                redirectUri: 'http://localhost:3000/callback',
                fetchFn: oauthErrorFetch(error)
            }),
            expectedClass,
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
            new Headers(init?.headers).forEach((v, k) => {
                headers[k] = v;
            });
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
        expect(noTokensMcpHeaders[0]['authorization']).toBeUndefined();

        // The resulting 401 re-entered the auth flow: the user is redirected to the authorization endpoint.
        expect(noTokensProvider.redirectedTo).toHaveLength(1);
        expect(noTokensProvider.redirectedTo[0].origin + noTokensProvider.redirectedTo[0].pathname).toBe(`${ISSUER}/authorize`);
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
        expect(noRefreshProvider.redirectedTo[0].origin + noRefreshProvider.redirectedTo[0].pathname).toBe(`${ISSUER}/authorize`);
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
            (e: unknown) => e
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
        expect(provider.redirectedTo[0].origin + provider.redirectedTo[0].pathname).toBe(`${ISSUER}/authorize`);
        expect(provider.saved.codeVerifier).toBeDefined();

        // finishAuth exchanges the callback code for tokens, mirroring the streamable HTTP transport surface.
        await authTransport.finishAuth('granted-authorization-code');
        expect(as.tokenCalls).toHaveLength(1);
        expect(as.tokenCalls[0].body.get('grant_type')).toBe('authorization_code');
        expect(as.tokenCalls[0].body.get('code')).toBe('granted-authorization-code');
        expect(provider.saved.tokens?.access_token).toBe('sse-access-token');
    } finally {
        await authTransport.close();
    }
});

verifies('typescript:consumer:oauth-provider-isolation', async (_args: TestArgs) => {
    // Gateway shape: one upstream server, two users, one OAuthClientProvider per user. The full authorization-code
    // flow runs for both, with the connect (discovery + redirect) phases interleaved concurrently; nothing from one
    // flow may leak into the other provider's persisted state or onto the other transport's requests.
    const as = createMockAuthorizationServer({
        tokenResponses: [
            { access_token: 'token-a', token_type: 'Bearer' },
            { access_token: 'token-b', token_type: 'Bearer' }
        ]
    });
    const validTokens = new Set(['token-a', 'token-b']);
    const mcpHost = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        // The hosting helper does no bearer verification of its own, so identity is read from the raw request
        // headers the SDK forwards into the handler — proving which credential reached this session's server.
        s.registerTool('whoami', { inputSchema: z.object({}) }, (_a, extra) => ({
            content: [{ type: 'text', text: `auth:${extra.requestInfo?.headers['authorization']}` }]
        }));
        return s;
    });

    const makeProvider = (tag: string, clientId: string) => {
        const provider = new RecordingOAuthClientProvider({ clientInformation: { client_id: clientId } });
        // Deterministic, distinguishable state values (the shared recording provider's default is time-based and
        // two providers created in the same millisecond would collide, blinding the isolation asserts).
        provider.state = () => {
            provider.saved.state = `state-${tag}`;
            return provider.saved.state;
        };
        return provider;
    };
    const providerA = makeProvider('a', 'client-a');
    const providerB = makeProvider('b', 'client-b');

    // Per-client recording fetch against the SHARED host + AS: tags every MCP request with the Authorization
    // header it carried. The host accepts either valid token, so cross-contamination would NOT 401 — only the
    // per-transport recordings can prove each client sent its own.
    const makeRecordingFetch = (recorded: Array<{ method: string; authorization: string | null }>) => {
        return async (url: URL | string, init?: RequestInit): Promise<Response> => {
            const urlObj = typeof url === 'string' ? new URL(url) : url;
            if (urlObj.origin === ISSUER || urlObj.pathname.includes('/.well-known/')) {
                return as.handleRequest(new Request(url, init));
            }
            const headers = new Headers(init?.headers);
            recorded.push({ method: init?.method ?? 'GET', authorization: headers.get('authorization') });
            const token = headers.get('authorization')?.replace(/^Bearer /, '');
            if (!token) {
                return new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"` }
                });
            }
            if (!validTokens.has(token)) {
                return new Response(null, { status: 401 });
            }
            return mcpHost.handleRequest(new Request(url, init));
        };
    };
    const requestsA: Array<{ method: string; authorization: string | null }> = [];
    const requestsB: Array<{ method: string; authorization: string | null }> = [];

    const clientA = new Client({ name: 'a', version: '0' });
    const clientB = new Client({ name: 'b', version: '0' });
    const transportA = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: providerA,
        fetch: makeRecordingFetch(requestsA)
    });
    const transportB = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: providerB,
        fetch: makeRecordingFetch(requestsB)
    });

    let verifierA!: string;
    let verifierB!: string;
    try {
        // Phase 1 — both interactive flows start CONCURRENTLY against the same AS.
        await Promise.all([
            expect(clientA.connect(transportA)).rejects.toThrow(UnauthorizedError),
            expect(clientB.connect(transportB)).rejects.toThrow(UnauthorizedError)
        ]);

        // Each provider holds exactly its own flow state: its client_id, its state value, and a code challenge
        // derived from its OWN verifier (the cross-pair must NOT match).
        expect(providerA.redirectedTo).toHaveLength(1);
        expect(providerB.redirectedTo).toHaveLength(1);
        const authUrlA = providerA.redirectedTo[0];
        const authUrlB = providerB.redirectedTo[0];
        expect(authUrlA.searchParams.get('client_id')).toBe('client-a');
        expect(authUrlB.searchParams.get('client_id')).toBe('client-b');
        expect(authUrlA.searchParams.get('state')).toBe('state-a');
        expect(authUrlB.searchParams.get('state')).toBe('state-b');
        verifierA = providerA.saved.codeVerifier!;
        verifierB = providerB.saved.codeVerifier!;
        expect(verifierA).not.toBe(verifierB);
        expect(authUrlA.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifierA).digest('base64url'));
        expect(authUrlB.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifierB).digest('base64url'));

        // Phase 2 — finish both flows; each token exchange carries its own code and its own verifier.
        await transportA.finishAuth('code-a');
        await transportB.finishAuth('code-b');
        expect(as.tokenCalls).toHaveLength(2);
        expect(as.tokenCalls[0].body.get('code')).toBe('code-a');
        expect(as.tokenCalls[0].body.get('code_verifier')).toBe(verifierA);
        expect(as.tokenCalls[0].body.get('client_id')).toBe('client-a');
        expect(as.tokenCalls[1].body.get('code')).toBe('code-b');
        expect(as.tokenCalls[1].body.get('code_verifier')).toBe(verifierB);
        expect(as.tokenCalls[1].body.get('client_id')).toBe('client-b');
        expect(providerA.saved.tokens?.access_token).toBe('token-a');
        expect(providerB.saved.tokens?.access_token).toBe('token-b');
    } finally {
        await Promise.all([clientA.close(), clientB.close()]);
    }

    // Phase 3 — fresh transports, same providers (the consumer pattern: providers persist, transports come and
    // go). Connect and call CONCURRENTLY; every request each transport makes must carry its own provider's token.
    const clientA2 = new Client({ name: 'a2', version: '0' });
    const clientB2 = new Client({ name: 'b2', version: '0' });
    requestsA.length = 0;
    requestsB.length = 0;
    try {
        await Promise.all([
            clientA2.connect(
                new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: providerA, fetch: makeRecordingFetch(requestsA) })
            ),
            clientB2.connect(
                new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: providerB, fetch: makeRecordingFetch(requestsB) })
            )
        ]);
        const [resultA, resultB] = await Promise.all([
            clientA2.callTool({ name: 'whoami', arguments: {} }),
            clientB2.callTool({ name: 'whoami', arguments: {} })
        ]);
        // The server saw each client authenticated as itself.
        expect(resultA.content).toEqual([{ type: 'text', text: 'auth:Bearer token-a' }]);
        expect(resultB.content).toEqual([{ type: 'text', text: 'auth:Bearer token-b' }]);

        // Bearer isolation on EVERY request either transport made — including the standalone GET.
        await vi.waitFor(() => expect(requestsA.some(r => r.method === 'GET')).toBe(true));
        await vi.waitFor(() => expect(requestsB.some(r => r.method === 'GET')).toBe(true));
        for (const req of requestsA) {
            expect(req.authorization).toBe('Bearer token-a');
        }
        for (const req of requestsB) {
            expect(req.authorization).toBe('Bearer token-b');
        }

        // Provider state untouched by the other flow end-to-end.
        expect(providerA.saved).toMatchObject({
            clientInformation: { client_id: 'client-a' },
            codeVerifier: verifierA,
            tokens: { access_token: 'token-a' }
        });
        expect(providerB.saved).toMatchObject({
            clientInformation: { client_id: 'client-b' },
            tokens: { access_token: 'token-b' }
        });
    } finally {
        await Promise.all([clientA2.close(), clientB2.close(), mcpHost.close()]);
    }
});
