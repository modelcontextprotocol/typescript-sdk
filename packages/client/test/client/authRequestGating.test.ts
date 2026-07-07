/**
 * Structural coverage of the discovery URL policy across the client OAuth flow:
 * every request the flow issues, and every discovery-derived URL it adopts, must
 * pass through {@linkcode assertAllowedDiscoveryUrl} before the request (or
 * adoption) happens.
 *
 * Unlike the per-rule wiring tests in `authDiscoveryPolicy.test.ts`, these tests
 * instrument the gate itself and drive the full flow legs — discovery,
 * registration, authorization redirect, code exchange (callback leg), token
 * refresh, and the Cross-App Access token exchanges — asserting for each leg that:
 *
 * 1. the recorded gate purposes cover exactly the expected set,
 * 2. every URL handed to `fetchFn` was validated before that request was issued, and
 * 3. the provider's `validateDiscoveryURL` hook ran for exactly the same
 *    (purpose, URL) set as the mechanical gate — every checkpoint invokes both.
 *    (The standalone Cross-App Access helpers run without a provider, so only
 *    assertions 1–2 apply to their legs.)
 *
 * A future code path that issues a request without the gate fails assertion 2;
 * one that gates a URL without threading the provider hook fails assertion 3;
 * a new {@linkcode DiscoveryUrlPurpose} member that no flow leg produces fails
 * the exhaustiveness check at the bottom (the `Record` forces the list to be
 * updated, and the assertion forces a leg to produce it).
 */
import type { AuthorizationServerMetadata, DiscoveryUrlContext, DiscoveryUrlPurpose } from '@modelcontextprotocol/core-internal';
import { assertAllowedDiscoveryUrl } from '@modelcontextprotocol/core-internal';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import { auth } from '../../src/client/auth';
import { discoverAndRequestJwtAuthGrant, exchangeJwtAuthGrant, requestJwtAuthorizationGrant } from '../../src/client/crossAppAccess';

vi.mock('@modelcontextprotocol/core-internal', async importOriginal => {
    const actual = await importOriginal<typeof import('@modelcontextprotocol/core-internal')>();
    return {
        ...actual,
        assertAllowedDiscoveryUrl: vi.fn(actual.assertAllowedDiscoveryUrl)
    };
});

// Mock pkce-challenge (startAuthorization generates a challenge before returning)
vi.mock('pkce-challenge', () => ({
    default: () => ({
        code_verifier: 'test_verifier',
        code_challenge: 'test_challenge'
    })
}));

const gateSpy = vi.mocked(assertAllowedDiscoveryUrl);

const SERVER_URL = 'https://mcp.example.com/mcp';
const PRM_WELL_KNOWN = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const AS_URL = 'https://auth.example.com';
const AS_WELL_KNOWN = 'https://auth.example.com/.well-known/oauth-authorization-server';

function jsonResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body
    } as unknown as Response;
}

function redirectResponse(status: number, location: string): Response {
    return {
        ok: false,
        status,
        headers: new Headers({ location }),
        text: async () => ''
    } as unknown as Response;
}

const AS_METADATA: AuthorizationServerMetadata = {
    issuer: AS_URL,
    authorization_endpoint: `${AS_URL}/authorize`,
    token_endpoint: `${AS_URL}/token`,
    registration_endpoint: `${AS_URL}/register`,
    response_types_supported: ['code']
};

const RESOURCE_METADATA = {
    resource: SERVER_URL,
    authorization_servers: [AS_URL]
};

const CLIENT_INFO = {
    client_id: 'client-abc',
    redirect_uris: ['http://localhost:3000/callback']
};

const TOKENS = {
    access_token: 'access-123',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'refresh-456'
};

/** A recording fetch mock routing by exact URL prefix; unrouted URLs reject loudly. */
function routedFetch(routes: Record<string, () => Response>): Mock {
    return vi.fn(async (url: string | URL) => {
        const urlString = url.toString();
        for (const [prefix, respond] of Object.entries(routes)) {
            if (urlString === prefix || urlString.startsWith(prefix)) {
                return respond();
            }
        }
        throw new Error(`Unrouted fetch: ${urlString}`);
    });
}

/**
 * Records every context the provider's `validateDiscoveryURL` hook receives.
 * Cleared per test; compared against the gate's recorded contexts to assert the
 * hook runs at every checkpoint.
 */
const hookSpy = vi.fn<(ctx: DiscoveryUrlContext) => void>();

function createProvider(overrides: Partial<OAuthClientProvider> = {}): OAuthClientProvider {
    return {
        validateDiscoveryURL: hookSpy,
        get redirectUrl() {
            return 'http://localhost:3000/callback';
        },
        get clientMetadata() {
            return {
                redirect_uris: ['http://localhost:3000/callback'],
                client_name: 'Test Client'
            };
        },
        clientInformation: vi.fn().mockResolvedValue(undefined),
        saveClientInformation: vi.fn(),
        tokens: vi.fn().mockResolvedValue(undefined),
        saveTokens: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn().mockResolvedValue('test_verifier'),
        ...overrides
    };
}

/** Provider mid-flow: discovery state, client credentials, and code verifier persisted. */
function createCallbackLegProvider(overrides: Partial<OAuthClientProvider> = {}): OAuthClientProvider {
    return createProvider({
        clientInformation: vi.fn().mockResolvedValue({ ...CLIENT_INFO, issuer: AS_URL }),
        discoveryState: vi.fn().mockResolvedValue({
            authorizationServerUrl: AS_URL,
            resourceMetadata: RESOURCE_METADATA,
            authorizationServerMetadata: AS_METADATA
        }),
        saveDiscoveryState: vi.fn(),
        ...overrides
    });
}

function recordedContexts(): DiscoveryUrlContext[] {
    return gateSpy.mock.calls.map(call => call[0]);
}

function recordedPurposes(): Set<DiscoveryUrlPurpose> {
    return new Set(recordedContexts().map(ctx => ctx.purpose));
}

/**
 * The structural invariant: every URL handed to `fetchFn` had a gate call for
 * that exact URL earlier in the run (vitest's `invocationCallOrder` is a global
 * sequence across mocks, so "earlier" means before the request was issued).
 */
function expectEveryRequestValidatedFirst(fetchFn: Mock): void {
    // Only gate calls for purposes the SDK requests may vouch for a request:
    // 'authorization-server' and 'authorization-endpoint' are asserted without a
    // request, and counting them here could mask a same-URL request elsewhere
    // that skipped its own check. Missing order entries resolve so the
    // containing assertion fails (fail closed).
    const assertOnlyPurposes: ReadonlySet<DiscoveryUrlPurpose> = new Set(['authorization-server', 'authorization-endpoint']);
    const gateCalls = gateSpy.mock.calls
        .map((call, index) => ({
            purpose: call[0].purpose,
            href: call[0].url.href,
            order: gateSpy.mock.invocationCallOrder[index] ?? Number.POSITIVE_INFINITY
        }))
        .filter(gate => !assertOnlyPurposes.has(gate.purpose));
    expect(fetchFn.mock.calls.length).toBeGreaterThan(0);
    for (const [index, call] of fetchFn.mock.calls.entries()) {
        const href = new URL(String(call[0])).href;
        const order = fetchFn.mock.invocationCallOrder[index] ?? Number.NEGATIVE_INFINITY;
        const validatedFirst = gateCalls.some(gate => gate.href === href && gate.order < order);
        expect(validatedFirst, `request to ${href} was issued without a prior URL-policy check`).toBe(true);
    }
}

function contextKey(ctx: DiscoveryUrlContext): string {
    return `${ctx.purpose} ${ctx.url.href}`;
}

/**
 * The hook invariant: the provider's `validateDiscoveryURL` hook received exactly
 * the (purpose, URL) pairs the mechanical gate validated — no checkpoint runs the
 * gate without also running the hook, and the hook is never invoked on a URL the
 * gate did not see first.
 */
function expectHookMirrorsGate(): void {
    const gateKeys = new Set(recordedContexts().map(contextKey));
    const hookKeys = new Set(hookSpy.mock.calls.map(call => contextKey(call[0])));
    expect(hookKeys).toEqual(gateKeys);
}

/**
 * Compile-time exhaustive list of purposes. Adding a member to
 * {@linkcode DiscoveryUrlPurpose} fails this initializer until the new purpose
 * is listed — and the exhaustiveness test below then requires a flow leg that
 * actually produces it.
 */
const ALL_PURPOSES: Record<DiscoveryUrlPurpose, true> = {
    'resource-metadata': true,
    'authorization-server': true,
    'as-metadata': true,
    'authorization-endpoint': true,
    'token-endpoint': true,
    'registration-endpoint': true,
    'redirect-hop': true
};

const producedPurposes = new Set<DiscoveryUrlPurpose>();

function recordLeg(): void {
    for (const purpose of recordedPurposes()) {
        producedPurposes.add(purpose);
    }
}

describe('request gating across the client OAuth flow legs', () => {
    beforeEach(() => {
        gateSpy.mockClear();
        hookSpy.mockClear();
    });

    it('discovery + registration + authorization redirect: every leg-specific purpose is gated and every request validated first', async () => {
        const provider = createProvider();
        const fetchFn = routedFetch({
            [PRM_WELL_KNOWN]: () => jsonResponse(RESOURCE_METADATA),
            [AS_WELL_KNOWN]: () => jsonResponse(AS_METADATA),
            [`${AS_URL}/register`]: () => jsonResponse(CLIENT_INFO)
        });

        const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn });

        expect(result).toBe('REDIRECT');
        expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
        expect(recordedPurposes()).toEqual(
            new Set(['resource-metadata', 'authorization-server', 'as-metadata', 'registration-endpoint', 'authorization-endpoint'])
        );
        expectEveryRequestValidatedFirst(fetchFn);
        expectHookMirrorsGate();

        // The registration request (a POST carrying the client metadata) was gated
        // with the endpoint's own purpose, keyed on the authorization server that
        // published the endpoint.
        const registrationContext = recordedContexts().find(ctx => ctx.purpose === 'registration-endpoint');
        expect(registrationContext?.url.href).toBe(`${AS_URL}/register`);
        expect(registrationContext?.producer.url.href).toBe(`${AS_URL}/`);
        expect(registrationContext?.producer.kind).toBe('authorization-server');

        // Discovery-phase contexts carry the MCP server as the producing step.
        const resourceMetadataContext = recordedContexts().find(ctx => ctx.purpose === 'resource-metadata');
        expect(resourceMetadataContext?.producer.url.href).toBe(SERVER_URL);
        expect(resourceMetadataContext?.producer.kind).toBe('mcp-server');

        // The redirect target is asserted even though the SDK never requests it.
        // (Compare origin + pathname: the flow appends the authorization request
        // parameters to the same URL instance after the assertion.)
        const authorizationEndpointContext = recordedContexts().find(ctx => ctx.purpose === 'authorization-endpoint');
        expect(authorizationEndpointContext && authorizationEndpointContext.url.origin + authorizationEndpointContext.url.pathname).toBe(
            `${AS_URL}/authorize`
        );

        recordLeg();
    });

    it('a redirected discovery response gates each Location target as a redirect-hop before following it', async () => {
        const movedUrl = 'https://mcp.example.com/prm-moved';
        const provider = createProvider();
        const fetchFn = routedFetch({
            [PRM_WELL_KNOWN]: () => redirectResponse(302, movedUrl),
            [movedUrl]: () => jsonResponse(RESOURCE_METADATA),
            [AS_WELL_KNOWN]: () => jsonResponse(AS_METADATA),
            [`${AS_URL}/register`]: () => jsonResponse(CLIENT_INFO)
        });

        const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn });

        expect(result).toBe('REDIRECT');
        expect(recordedPurposes()).toEqual(
            new Set([
                'resource-metadata',
                'redirect-hop',
                'authorization-server',
                'as-metadata',
                'registration-endpoint',
                'authorization-endpoint'
            ])
        );
        expectEveryRequestValidatedFirst(fetchFn);
        expectHookMirrorsGate();

        const hopContext = recordedContexts().find(ctx => ctx.purpose === 'redirect-hop');
        expect(hopContext?.url.href).toBe(movedUrl);
        expect(hopContext?.redirectHop?.originalPurpose).toBe('resource-metadata');

        recordLeg();
    });

    it('callback leg (authorization code exchange): the restored server URL and the token request are both gated', async () => {
        const provider = createCallbackLegProvider();
        const fetchFn = routedFetch({
            [`${AS_URL}/token`]: () => jsonResponse(TOKENS)
        });

        const result = await auth(provider, { serverUrl: SERVER_URL, authorizationCode: 'code-789', fetchFn });

        expect(result).toBe('AUTHORIZED');
        expect(provider.saveTokens).toHaveBeenCalledTimes(1);
        expect(recordedPurposes()).toEqual(new Set(['authorization-server', 'token-endpoint']));
        expectEveryRequestValidatedFirst(fetchFn);
        expectHookMirrorsGate();

        // The authorization server URL restored from cached state is re-validated on
        // every restore, with its provenance on record.
        const restoreContext = recordedContexts().find(ctx => ctx.purpose === 'authorization-server');
        expect(restoreContext?.url.href).toBe(`${AS_URL}/`);
        expect(restoreContext?.source).toBe('cached-discovery-state');
        expect(restoreContext?.producer.url.href).toBe(SERVER_URL);
        expect(restoreContext?.producer.kind).toBe('mcp-server');

        // The token request (the POST carrying the authorization code and verifier)
        // is gated with the endpoint's own purpose before the request.
        const tokenContext = recordedContexts().find(ctx => ctx.purpose === 'token-endpoint');
        expect(tokenContext?.url.href).toBe(`${AS_URL}/token`);
        expect(tokenContext?.source).toBe('authorization-server-metadata');
        expect(tokenContext?.producer.url.href).toBe(`${AS_URL}/`);
        expect(tokenContext?.producer.kind).toBe('authorization-server');

        recordLeg();
    });

    it('refresh leg: the refresh-token request is gated as a token-endpoint request', async () => {
        const provider = createCallbackLegProvider({
            tokens: vi.fn().mockResolvedValue({ ...TOKENS, issuer: AS_URL })
        });
        const fetchFn = routedFetch({
            [`${AS_URL}/token`]: () => jsonResponse({ ...TOKENS, access_token: 'access-refreshed' })
        });

        const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn });

        expect(result).toBe('AUTHORIZED');
        expect(provider.saveTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'access-refreshed' }), {
            issuer: AS_URL
        });
        expect(recordedPurposes()).toEqual(new Set(['authorization-server', 'token-endpoint']));
        expectEveryRequestValidatedFirst(fetchFn);
        expectHookMirrorsGate();

        const tokenContext = recordedContexts().find(ctx => ctx.purpose === 'token-endpoint');
        expect(tokenContext?.url.href).toBe(`${AS_URL}/token`);

        recordLeg();
    });

    it('the flow legs above produce every declared DiscoveryUrlPurpose (no purpose is vocabulary-only)', () => {
        // Runs after the leg tests in this file (vitest executes a file's tests in
        // declaration order). If this fails, either a leg regressed or a new purpose
        // was added without a flow leg that produces it.
        expect([...producedPurposes].toSorted()).toEqual(Object.keys(ALL_PURPOSES).toSorted());
    });
});

describe('request gating for the Cross-App Access token legs', () => {
    // These standalone helpers run without an OAuthClientProvider, so only the
    // mechanical gate applies — there is no validateDiscoveryURL hook on this path.
    const IDP_URL = 'https://idp.example.com';
    const IDP_WELL_KNOWN = 'https://idp.example.com/.well-known/oauth-authorization-server';

    const IDP_METADATA = {
        issuer: IDP_URL,
        authorization_endpoint: `${IDP_URL}/authorize`,
        token_endpoint: `${IDP_URL}/token`,
        response_types_supported: ['code']
    };

    const JAG_RESPONSE = {
        issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        access_token: 'jag-token',
        token_type: 'N_A'
    };

    beforeEach(() => {
        gateSpy.mockClear();
    });

    it('requestJwtAuthorizationGrant: the exchange POST is gated as a token-endpoint request anchored on the caller-named endpoint', async () => {
        const fetchFn = routedFetch({
            [`${IDP_URL}/token`]: () => jsonResponse(JAG_RESPONSE)
        });

        const result = await requestJwtAuthorizationGrant({
            tokenEndpoint: `${IDP_URL}/token`,
            audience: 'https://auth.chat.example/',
            resource: 'https://mcp.chat.example/',
            idToken: 'id-token',
            clientId: 'idp-client',
            fetchFn
        });

        expect(result.jwtAuthGrant).toBe('jag-token');
        expect(recordedPurposes()).toEqual(new Set(['token-endpoint']));
        expectEveryRequestValidatedFirst(fetchFn);

        // A caller-supplied endpoint is its own locality anchor, with the caller
        // provenance on record.
        const tokenContext = recordedContexts().find(ctx => ctx.purpose === 'token-endpoint');
        expect(tokenContext?.url.href).toBe(`${IDP_URL}/token`);
        expect(tokenContext?.source).toBe('caller');
        expect(tokenContext?.producer.url.href).toBe(`${IDP_URL}/token`);
        expect(tokenContext?.producer.kind).toBe('authorization-server');
    });

    it('discoverAndRequestJwtAuthGrant: discovery and the exchange POST are both gated, with the IdP issuer as the token-request producer', async () => {
        const fetchFn = routedFetch({
            [IDP_WELL_KNOWN]: () => jsonResponse(IDP_METADATA),
            [`${IDP_URL}/token`]: () => jsonResponse(JAG_RESPONSE)
        });

        const result = await discoverAndRequestJwtAuthGrant({
            idpUrl: IDP_URL,
            audience: 'https://auth.chat.example/',
            resource: 'https://mcp.chat.example/',
            idToken: 'id-token',
            clientId: 'idp-client',
            fetchFn
        });

        expect(result.jwtAuthGrant).toBe('jag-token');
        expect(recordedPurposes()).toEqual(new Set(['as-metadata', 'token-endpoint']));
        expectEveryRequestValidatedFirst(fetchFn);

        // The endpoint was published by the IdP's metadata, so the IdP issuer
        // anchors the locality check for the token request.
        const tokenContext = recordedContexts().find(ctx => ctx.purpose === 'token-endpoint');
        expect(tokenContext?.url.href).toBe(`${IDP_URL}/token`);
        expect(tokenContext?.source).toBe('authorization-server-metadata');
        expect(tokenContext?.producer.url.href).toBe(`${IDP_URL}/`);
        expect(tokenContext?.producer.kind).toBe('authorization-server');
    });

    it('exchangeJwtAuthGrant: the jwt-bearer POST is gated as a token-endpoint request before credentials are sent', async () => {
        const fetchFn = routedFetch({
            [`${AS_URL}/token`]: () => jsonResponse(TOKENS)
        });

        const result = await exchangeJwtAuthGrant({
            tokenEndpoint: `${AS_URL}/token`,
            jwtAuthGrant: 'jag-token',
            clientId: 'mcp-client',
            clientSecret: 'mcp-secret',
            fetchFn
        });

        expect(result.access_token).toBe(TOKENS.access_token);
        expect(recordedPurposes()).toEqual(new Set(['token-endpoint']));
        expectEveryRequestValidatedFirst(fetchFn);

        const tokenContext = recordedContexts().find(ctx => ctx.purpose === 'token-endpoint');
        expect(tokenContext?.url.href).toBe(`${AS_URL}/token`);
        expect(tokenContext?.source).toBe('caller');
        expect(tokenContext?.producer.url.href).toBe(`${AS_URL}/token`);
        expect(tokenContext?.producer.kind).toBe('authorization-server');
    });
});
