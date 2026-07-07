/**
 * Wiring tests for the discovery URL policy in the client OAuth flow:
 * RFC 9728 §3 (protected-resource metadata location), RFC 9728 §7.6
 * (authorization server trust verification), RFC 8414 §2 (issuer syntax), and
 * fail-closed pre-request validation of every discovery-derived URL, including
 * redirect targets and endpoints resolved from authorization server metadata.
 *
 * Each rejection case asserts that no request is ever issued to the rejected
 * URL — validation happens before network I/O, not after.
 */
import type { AuthorizationServerMetadata, DiscoveryUrlContext } from '@modelcontextprotocol/core-internal';
import { createFetchWithInit, DiscoveryUrlBlockedError, normalizeHeaders, OMIT_BASE_HEADERS } from '@modelcontextprotocol/core-internal';
import type { Mock } from 'vitest';
import { expect, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import {
    auth,
    discoverAuthorizationServerMetadata,
    discoverOAuthProtectedResourceMetadata,
    discoverOAuthServerInfo,
    discoverOAuthServerInfoInternal,
    exchangeAuthorization,
    refreshAuthorization,
    registerClient,
    RegistrationRejectedError,
    startAuthorization,
    UnauthorizedError
} from '../../src/client/auth';
import { RedirectFilteredResponseError } from '../../src/client/authErrors';
import { withOAuth } from '../../src/client/middleware';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

// Mock pkce-challenge (startAuthorization generates a challenge before returning)
vi.mock('pkce-challenge', () => ({
    default: () => ({
        code_verifier: 'test_verifier',
        code_challenge: 'test_challenge'
    })
}));

const SERVER_URL = 'https://mcp.example.com/mcp';

const PRM_WELL_KNOWN = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

function jsonResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body
    } as unknown as Response;
}

function redirectResponse(status: number, location?: string): Response {
    return {
        ok: false,
        status,
        headers: new Headers(location === undefined ? {} : { location }),
        text: async () => ''
    } as unknown as Response;
}

/**
 * The shape browser runtimes resolve a `redirect: 'manual'` fetch with when the
 * response status is a redirect: an opaque redirect — status 0, no readable
 * headers (Fetch "opaqueredirect" filtered response).
 */
function opaqueRedirectResponse(): Response {
    return {
        ok: false,
        status: 0,
        type: 'opaqueredirect',
        headers: new Headers(),
        text: async () => ''
    } as unknown as Response;
}

function notFoundResponse(): Response {
    return {
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => ''
    } as unknown as Response;
}

function resourceMetadataFor(serverUrl: string, authorizationServer: string): Record<string, unknown> {
    return {
        resource: serverUrl,
        authorization_servers: [authorizationServer]
    };
}

function authServerMetadataFor(issuer: string): AuthorizationServerMetadata {
    const base = issuer.replace(/\/$/, '');
    return {
        issuer,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code']
    };
}

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
 * Fetch stub for the challenge-relay tests: the MCP endpoint answers 401 with a
 * `WWW-Authenticate` challenge naming `resourceMetadataUrl`, conformant metadata
 * is served at the SDK's own well-known derivation, and auth.example.com serves
 * its authorization server metadata.
 */
function challengeRelayFetch(resourceMetadataUrl: string): Mock {
    return routedFetch({
        [SERVER_URL]: () =>
            ({
                ok: false,
                status: 401,
                headers: new Headers({ 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` }),
                text: async () => ''
            }) as unknown as Response,
        [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
        'https://auth.example.com/.well-known/': () => jsonResponse(authServerMetadataFor('https://auth.example.com'))
    });
}

function requestedUrls(fetchMock: Mock): string[] {
    return fetchMock.mock.calls.map(call => String(call[0]));
}

function requestedHosts(fetchMock: Mock): string[] {
    return requestedUrls(fetchMock).map(url => new URL(url).hostname);
}

function createProvider(overrides: Partial<OAuthClientProvider> = {}): OAuthClientProvider {
    return {
        get redirectUrl() {
            return 'http://localhost:3000/callback';
        },
        get clientMetadata() {
            return {
                redirect_uris: ['http://localhost:3000/callback'],
                client_name: 'Test Client'
            };
        },
        clientInformation: vi.fn().mockResolvedValue({
            client_id: 'test-client-id',
            client_secret: 'test-client-secret'
        }),
        tokens: vi.fn().mockResolvedValue(undefined),
        saveTokens: vi.fn(),
        redirectToAuthorization: vi.fn(),
        saveCodeVerifier: vi.fn(),
        codeVerifier: vi.fn().mockResolvedValue('test_verifier'),
        ...overrides
    };
}

describe('discovery URL policy wiring in the client OAuth flow', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    describe('protected-resource metadata URL (RFC 9728 §3)', () => {
        it('never requests a non-conformant challenge-relayed metadata URL; falls back to the same-origin well-known derivation with a warning', async () => {
            // Shape from the WWW-Authenticate-relayed metadata URL reports: the URL
            // names a link-local literal, and previously it was requested verbatim.
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            const metadata = await discoverOAuthProtectedResourceMetadata(
                SERVER_URL,
                { resourceMetadataUrl: 'http://169.254.169.254/latest/meta-data/', resourceMetadataUrlSource: 'www-authenticate' },
                fetchFn
            );

            expect(metadata.resource).toBe(SERVER_URL);
            const urls = requestedUrls(fetchFn);
            expect(urls).toEqual([PRM_WELL_KNOWN]);
            expect(urls.map(url => new URL(url).hostname)).not.toContain('169.254.169.254');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('well-known'));
        });

        it('never requests a cross-origin https challenge-relayed metadata URL either (origin rule, not just scheme)', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            await discoverOAuthProtectedResourceMetadata(
                SERVER_URL,
                {
                    resourceMetadataUrl: 'https://other.example.com/.well-known/oauth-protected-resource',
                    resourceMetadataUrlSource: 'www-authenticate'
                },
                fetchFn
            );

            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('a caller-configured metadata URL that violates the policy fails closed: no fallback, no request', async () => {
            // Without a provenance label the URL is a configuration statement
            // (`'caller'`, the default): rejecting it must not silently discover at
            // a different location.
            const fetchFn = vi.fn();

            await expect(
                discoverOAuthProtectedResourceMetadata(
                    SERVER_URL,
                    { resourceMetadataUrl: 'https://other.example.com/.well-known/oauth-protected-resource' },
                    fetchFn
                )
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('honors a cross-origin resource_metadata URL only with allowCrossOriginResourceMetadata', async () => {
            const crossOriginUrl = 'https://gateway.example.com/prm';
            const fetchFn = routedFetch({
                [crossOriginUrl]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            const metadata = await discoverOAuthProtectedResourceMetadata(
                SERVER_URL,
                { resourceMetadataUrl: crossOriginUrl, discoveryPolicy: { allowCrossOriginResourceMetadata: true } },
                fetchFn
            );

            expect(metadata.resource).toBe(SERVER_URL);
            expect(requestedUrls(fetchFn)).toEqual([crossOriginUrl]);
        });

        it('fails closed before any request when the derived well-known URL itself violates the policy', async () => {
            // A non-loopback http server URL derives a non-loopback http discovery URL.
            const fetchFn = vi.fn();

            await expect(discoverOAuthProtectedResourceMetadata('http://mcp.example.com/mcp', undefined, fetchFn)).rejects.toThrow(
                DiscoveryUrlBlockedError
            );
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });

    describe('authorization server adoption (RFC 9728 §7.6)', () => {
        it('rejects a loopback-literal authorization server published by a remote server, before any request to it', async () => {
            // Shape shared by the authorization_servers[0] reports: remote server,
            // protected-resource metadata naming a loopback listener.
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'http://127.0.0.1:9292'))
            });

            await expect(discoverOAuthServerInfo(SERVER_URL, { fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);

            const urls = requestedUrls(fetchFn);
            expect(urls).toEqual([PRM_WELL_KNOWN]);
            expect(urls.map(url => new URL(url).hostname)).not.toContain('127.0.0.1');
        });

        it('rejects a link-local http authorization server (structural rule) with zero requests to it', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'http://169.254.169.254'))
            });

            await expect(discoverOAuthServerInfo(SERVER_URL, { fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('rejects a private-range https literal from a remote server (locality rule)', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://10.0.0.8'))
            });

            await expect(discoverOAuthServerInfo(SERVER_URL, { fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('does not fall back to the legacy server-derived authorization server when the published entry is rejected', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'http://127.0.0.1:9292'))
            });

            await expect(discoverOAuthServerInfo(SERVER_URL, { fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            // Fail closed: no request to https://mcp.example.com/.well-known/oauth-authorization-server either.
            expect(requestedUrls(fetchFn).some(url => url.includes('oauth-authorization-server'))).toBe(false);
        });

        it('keeps a loopback server with a loopback authorization server working (local development)', async () => {
            const localServer = 'http://localhost:3111/mcp';
            const fetchFn = routedFetch({
                'http://localhost:3111/.well-known/oauth-protected-resource/mcp': () =>
                    jsonResponse(resourceMetadataFor(localServer, 'http://localhost:9000')),
                'http://localhost:9000/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('http://localhost:9000'))
            });

            const info = await discoverOAuthServerInfo(localServer, { fetchFn });
            expect(info.authorizationServerUrl).toBe('http://localhost:9000');
            expect(info.authorizationServerMetadata?.issuer).toBe('http://localhost:9000');
        });

        it('keeps a public https authorization server on a different origin working (cross-origin AS is conformant)', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
                'https://auth.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            const info = await discoverOAuthServerInfo(SERVER_URL, { fetchFn });
            expect(info.authorizationServerUrl).toBe('https://auth.example.com');
            expect(info.authorizationServerMetadata?.issuer).toBe('https://auth.example.com');
        });

        it('keeps an authorization server on a private https DNS name working (no name resolution in the policy)', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://idp.corp.internal')),
                'https://idp.corp.internal/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://idp.corp.internal'))
            });

            const info = await discoverOAuthServerInfo(SERVER_URL, { fetchFn });
            expect(info.authorizationServerUrl).toBe('https://idp.corp.internal');
        });

        it('allowPrivateAddressTargets permits a private-literal authorization server explicitly', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://10.0.0.8')),
                'https://10.0.0.8/.well-known/oauth-authorization-server': () => jsonResponse(authServerMetadataFor('https://10.0.0.8'))
            });

            const info = await discoverOAuthServerInfo(SERVER_URL, {
                fetchFn,
                discoveryPolicy: { allowPrivateAddressTargets: true }
            });
            expect(info.authorizationServerUrl).toBe('https://10.0.0.8');
        });
    });

    // These drive discoverOAuthServerInfoInternal, whose trust parameter carries
    // the shape auth() resolves from the provider's trustedAuthorizationServers /
    // validateDiscoveryURL members. There is no trust input on the public
    // signature; trust flows only from the provider (RFC 9728 §7.6).
    describe('trustedAuthorizationServers and validateDiscoveryURL (RFC 9728 §7.6)', () => {
        it('trustedAuthorizationServers is exhaustive: a non-matching issuer is rejected before its metadata is requested', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            await expect(
                discoverOAuthServerInfoInternal(
                    SERVER_URL,
                    { fetchFn },
                    {
                        trustedAuthorizationServers: ['https://trusted.example.com']
                    }
                )
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('trustedAuthorizationServers accepts a matching issuer identifier (string or URL entries)', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
                'https://auth.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            const info = await discoverOAuthServerInfoInternal(
                SERVER_URL,
                { fetchFn },
                {
                    trustedAuthorizationServers: [new URL('https://auth.example.com'), 'https://other.example.com']
                }
            );
            expect(info.authorizationServerUrl).toBe('https://auth.example.com');
        });

        it('entries are full issuer identifiers with trailing-slash tolerance only, not origins', async () => {
            // Path-distinguished issuers on one host (RFC 8414 §2 permits a path
            // component): listing one tenant does not trust another on the same host.
            const tenantMetadata = resourceMetadataFor(SERVER_URL, 'https://auth.example.com/tenant1');
            const rejectedFetch = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(tenantMetadata)
            });
            await expect(
                discoverOAuthServerInfoInternal(
                    SERVER_URL,
                    { fetchFn: rejectedFetch },
                    {
                        trustedAuthorizationServers: ['https://auth.example.com/tenant2']
                    }
                )
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(rejectedFetch)).toEqual([PRM_WELL_KNOWN]);
        });

        it('an origin-only entry does not match a path-distinguished issuer', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com/tenant1'))
            });

            await expect(
                discoverOAuthServerInfoInternal(
                    SERVER_URL,
                    { fetchFn },
                    {
                        trustedAuthorizationServers: ['https://auth.example.com']
                    }
                )
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('tolerates a trailing-slash difference between the entry and the issuer', async () => {
            const issuer = 'https://auth.example.com/tenant1';
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, issuer)),
                'https://auth.example.com/.well-known/oauth-authorization-server/tenant1': () => jsonResponse(authServerMetadataFor(issuer))
            });

            const info = await discoverOAuthServerInfoInternal(
                SERVER_URL,
                { fetchFn },
                {
                    trustedAuthorizationServers: ['https://auth.example.com/tenant1/']
                }
            );
            expect(info.authorizationServerUrl).toBe(issuer);
        });

        it('the trust list applies to the legacy server-derived fallback: a server without protected-resource metadata is rejected unless its base URL is listed', async () => {
            // Serving 404 on the well-known endpoint routes discovery into the legacy
            // fallback (serverUrl acts as the authorization server) — that adoption
            // must pass the same trust verification as one named by the metadata.
            const fetchFn = routedFetch({
                'https://mcp.example.com/.well-known/oauth-protected-resource': () => notFoundResponse()
            });

            await expect(
                discoverOAuthServerInfoInternal(
                    SERVER_URL,
                    { fetchFn },
                    {
                        trustedAuthorizationServers: ['https://trusted.example.com']
                    }
                )
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            // Rejected before any authorization-server metadata request.
            expect(requestedUrls(fetchFn).some(url => url.includes('oauth-authorization-server'))).toBe(false);
        });

        it('the legacy fallback is accepted when the server base URL is on the trust list', async () => {
            const fetchFn = routedFetch({
                'https://mcp.example.com/.well-known/oauth-protected-resource': () => notFoundResponse(),
                'https://mcp.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://mcp.example.com'))
            });

            const info = await discoverOAuthServerInfoInternal(
                SERVER_URL,
                { fetchFn },
                {
                    trustedAuthorizationServers: ['https://mcp.example.com']
                }
            );
            expect(info.authorizationServerUrl).toBe('https://mcp.example.com/');
        });

        it("validateDiscoveryURL runs on the legacy fallback adoption with source 'sdk-derived' (and on each request checkpoint)", async () => {
            const seenContexts: DiscoveryUrlContext[] = [];
            const fetchFn = routedFetch({
                'https://mcp.example.com/.well-known/oauth-protected-resource': () => notFoundResponse(),
                'https://mcp.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://mcp.example.com'))
            });

            await discoverOAuthServerInfoInternal(
                SERVER_URL,
                { fetchFn },
                {
                    validateDiscoveryURL: ctx => {
                        seenContexts.push(ctx);
                    }
                }
            );

            const adoptions = seenContexts.filter(ctx => ctx.purpose === 'authorization-server');
            expect(adoptions).toHaveLength(1);
            expect(adoptions[0]!.source).toBe('sdk-derived');
            expect(adoptions[0]!.url.href).toBe('https://mcp.example.com/');
            expect(adoptions[0]!.producer.url.href).toBe(SERVER_URL);
            expect(adoptions[0]!.producer.kind).toBe('mcp-server');
            // The hook also ran before every request the discovery issued.
            expect(seenContexts.filter(ctx => ctx.purpose === 'resource-metadata').length).toBeGreaterThan(0);
            expect(seenContexts.filter(ctx => ctx.purpose === 'as-metadata').length).toBeGreaterThan(0);
        });

        it('auth() forwards the provider trust members and a rejecting validateDiscoveryURL fails the flow pre-request', async () => {
            const seenContexts: DiscoveryUrlContext[] = [];
            const provider = createProvider({
                validateDiscoveryURL: vi.fn((ctx: DiscoveryUrlContext) => {
                    seenContexts.push(ctx);
                    if (ctx.purpose === 'authorization-server') {
                        throw new DiscoveryUrlBlockedError(ctx, 'not on the application trust list');
                    }
                })
            });
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);

            const adoption = seenContexts.find(ctx => ctx.purpose === 'authorization-server');
            expect(adoption?.source).toBe('protected-resource-metadata');
            expect(adoption?.url.href).toBe('https://auth.example.com/');
            expect(adoption?.producer.url.href).toBe(SERVER_URL);
            expect(adoption?.producer.kind).toBe('mcp-server');
            // Rejected before any request reached the authorization server.
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('a hook throw that is not DiscoveryUrlBlockedError is wrapped, so callers see one failure type', async () => {
            const cause = new Error('issuer not in the tenant directory');
            const provider = createProvider({
                validateDiscoveryURL: vi.fn((ctx: DiscoveryUrlContext) => {
                    if (ctx.purpose === 'as-metadata') {
                        throw cause;
                    }
                })
            });
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            const failure = await auth(provider, { serverUrl: SERVER_URL, fetchFn }).then(
                () => undefined,
                error => error as Error
            );

            expect(failure).toBeInstanceOf(DiscoveryUrlBlockedError);
            expect(failure!.message).toContain('validateDiscoveryURL');
            expect(failure!.cause).toBe(cause);
            // The rejected request never left the client.
            expect(requestedUrls(fetchFn).some(url => url.includes('oauth-authorization-server'))).toBe(false);
        });

        it('the hook gates the authorization endpoint before the user agent is redirected to it', async () => {
            const provider = createProvider({
                validateDiscoveryURL: vi.fn((ctx: DiscoveryUrlContext) => {
                    if (ctx.purpose === 'authorization-endpoint') {
                        throw new DiscoveryUrlBlockedError(ctx, 'authorization endpoint not on the application trust list');
                    }
                })
            });
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
                'https://auth.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(provider.redirectToAuthorization).not.toHaveBeenCalled();
        });

        it('auth() applies the provider trustedAuthorizationServers list to adoption', async () => {
            const provider = createProvider({ trustedAuthorizationServers: ['https://trusted.example.com'] });
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });
    });

    describe('cached discovery state restore', () => {
        it('re-validates the cached authorization server URL and throws with zero requests when it violates policy', async () => {
            const provider = createProvider({
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: 'http://169.254.169.254',
                    resourceMetadata: resourceMetadataFor(SERVER_URL, 'http://169.254.169.254'),
                    authorizationServerMetadata: authServerMetadataFor('http://169.254.169.254')
                }),
                saveDiscoveryState: vi.fn()
            });
            const fetchFn = vi.fn();

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('applies the provider trust verification to a restored authorization server URL', async () => {
            const provider = createProvider({
                trustedAuthorizationServers: ['https://trusted.example.com'],
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: 'https://auth.example.com',
                    resourceMetadata: resourceMetadataFor(SERVER_URL, 'https://auth.example.com'),
                    authorizationServerMetadata: authServerMetadataFor('https://auth.example.com')
                }),
                saveDiscoveryState: vi.fn()
            });
            const fetchFn = vi.fn();

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });
    });

    describe('provider-level discovery policy (OAuthClientProvider.discoveryPolicy)', () => {
        const PRIVATE_AS = 'https://10.1.2.3';

        function privateAsRoutes(): Record<string, () => Response> {
            return {
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, PRIVATE_AS)),
                [`${PRIVATE_AS}/.well-known/oauth-authorization-server`]: () => jsonResponse(authServerMetadataFor(PRIVATE_AS))
            };
        }

        function unauthorizedResponse(): Response {
            return {
                ok: false,
                status: 401,
                headers: new Headers({ 'www-authenticate': 'Bearer realm="mcp"' }),
                text: async () => ''
            } as unknown as Response;
        }

        it('auth() reads the policy from the provider when the call passes none', async () => {
            const provider = createProvider({ discoveryPolicy: { allowPrivateAddressTargets: true } });
            const fetchFn = routedFetch(privateAsRoutes());

            const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn });

            expect(result).toBe('REDIRECT');
            expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
        });

        it('a per-call discoveryPolicy takes precedence over the provider policy', async () => {
            const provider = createProvider({ discoveryPolicy: { allowPrivateAddressTargets: true } });
            const fetchFn = routedFetch(privateAsRoutes());

            // An explicit per-call policy (here: no overrides at all) replaces the
            // provider policy wholesale — the effective policy is resolved once at
            // flow entry, not merged per option.
            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn, discoveryPolicy: {} })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedHosts(fetchFn)).not.toContain('10.1.2.3');
        });

        it('the provider policy reaches a transport-driven 401 flow (allowPrivateAddressTargets)', async () => {
            const provider = createProvider({ discoveryPolicy: { allowPrivateAddressTargets: true } });
            const routes = privateAsRoutes();
            const fetchFn = vi.fn(async (url: string | URL) => {
                const urlString = url.toString();
                if (urlString === SERVER_URL) {
                    return unauthorizedResponse();
                }
                for (const [prefix, respond] of Object.entries(routes)) {
                    if (urlString === prefix || urlString.startsWith(prefix)) {
                        return respond();
                    }
                }
                throw new Error(`Unrouted fetch: ${urlString}`);
            });
            const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider, fetch: fetchFn });

            // The flow ends at the interactive redirect, which the transport surfaces
            // as UnauthorizedError — the private https target was reached and adopted
            // because the provider policy permits it.
            await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(UnauthorizedError);
            expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
            const redirectTarget = (provider.redirectToAuthorization as Mock).mock.calls[0]![0] as URL;
            expect(redirectTarget.origin).toBe(PRIVATE_AS);
        });

        it('without the provider policy the same transport-driven flow fails closed before any request to the private target', async () => {
            const provider = createProvider();
            const fetchFn = vi.fn(async (url: string | URL) => {
                const urlString = url.toString();
                if (urlString === SERVER_URL) {
                    return unauthorizedResponse();
                }
                if (urlString === PRM_WELL_KNOWN) {
                    return jsonResponse(resourceMetadataFor(SERVER_URL, PRIVATE_AS));
                }
                throw new Error(`Unrouted fetch: ${urlString}`);
            });
            const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider, fetch: fetchFn });

            await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedHosts(fetchFn)).not.toContain('10.1.2.3');
        });

        it('a provider trust list is applied through a transport-driven flow without any per-call configuration', async () => {
            const provider = createProvider({ trustedAuthorizationServers: ['https://trusted.example.com'] });
            const fetchFn = vi.fn(async (url: string | URL) => {
                const urlString = url.toString();
                if (urlString === SERVER_URL) {
                    return unauthorizedResponse();
                }
                if (urlString === PRM_WELL_KNOWN) {
                    return jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'));
                }
                throw new Error(`Unrouted fetch: ${urlString}`);
            });
            const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider, fetch: fetchFn });

            // RFC 9728 §7.6: the adopted authorization server matches no trust-list
            // entry, so the flow fails closed before its metadata is requested.
            await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedHosts(fetchFn)).not.toContain('auth.example.com');
        });
    });

    describe('resource metadata URL provenance (resourceMetadataUrlSource)', () => {
        const CROSS_ORIGIN_PRM = 'https://other.example.com/prm';

        it('a non-conformant challenge-relayed metadata URL warns and falls back through a transport-driven 401 flow', async () => {
            const provider = createProvider();
            const fetchFn = challengeRelayFetch(CROSS_ORIGIN_PRM);
            const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider, fetch: fetchFn });

            // The transport relays the challenge's URL with its provenance on record,
            // so the RFC 9728 §3 origin rejection is handled by falling back to the
            // SDK's own well-known derivation; the flow then proceeds to the
            // interactive redirect (surfaced by the transport as UnauthorizedError).
            await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(UnauthorizedError);
            expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
            expect(requestedHosts(fetchFn)).not.toContain('other.example.com');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('well-known'));
        });

        it('a non-conformant challenge-relayed metadata URL warns and falls back through the withOAuth middleware', async () => {
            const provider = createProvider();
            const fetchFn = challengeRelayFetch(CROSS_ORIGIN_PRM);
            const enhancedFetch = withOAuth(provider, SERVER_URL)(fetchFn);

            // The middleware relays the challenge's URL with its provenance on record,
            // exactly like the transports: the RFC 9728 §3 origin rejection falls back
            // to the SDK's own well-known derivation, and the flow proceeds to the
            // interactive redirect (surfaced by the middleware as UnauthorizedError)
            // instead of failing on the non-conformant URL.
            await expect(enhancedFetch(SERVER_URL)).rejects.toThrow(UnauthorizedError);
            expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
            expect(requestedHosts(fetchFn)).not.toContain('other.example.com');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('well-known'));
        });

        it('a challenge-relayed metadata URL whose response is a filtered redirect warns and falls back to the well-known derivation', async () => {
            // The URL is conformant (same-origin), so it passes the pre-request
            // check and is fetched — but the runtime filters the redirect it
            // answers with. Same handling as a policy rejection of the URL:
            // warn, then derive the well-known location.
            const sameOriginPrm = 'https://mcp.example.com/custom-prm';
            const fetchFn = routedFetch({
                [sameOriginPrm]: () => opaqueRedirectResponse(),
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            const metadata = await discoverOAuthProtectedResourceMetadata(
                SERVER_URL,
                { resourceMetadataUrl: sameOriginPrm, resourceMetadataUrlSource: 'www-authenticate' },
                fetchFn
            );

            expect(metadata.resource).toBe(SERVER_URL);
            expect(requestedUrls(fetchFn)).toEqual([sameOriginPrm, PRM_WELL_KNOWN]);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('well-known'));
        });

        it('a caller-configured metadata URL whose response is a filtered redirect fails without falling back', async () => {
            const sameOriginPrm = 'https://mcp.example.com/custom-prm';
            const fetchFn = routedFetch({
                [sameOriginPrm]: () => opaqueRedirectResponse()
            });

            await expect(
                discoverOAuthProtectedResourceMetadata(SERVER_URL, { resourceMetadataUrl: sameOriginPrm }, fetchFn)
            ).rejects.toThrow(RedirectFilteredResponseError);
            // No well-known probe: a caller-configured URL is a configuration
            // statement, so discovery does not proceed at a different location.
            expect(requestedUrls(fetchFn)).toEqual([sameOriginPrm]);
        });

        it('a filtered redirect on a caller-configured metadata URL fails discoverOAuthServerInfo instead of degrading to the legacy fallback', async () => {
            const sameOriginPrm = 'https://mcp.example.com/custom-prm';
            const fetchFn = routedFetch({
                [sameOriginPrm]: () => opaqueRedirectResponse()
            });

            await expect(discoverOAuthServerInfo(SERVER_URL, { resourceMetadataUrl: new URL(sameOriginPrm), fetchFn })).rejects.toThrow(
                RedirectFilteredResponseError
            );
            // No fallback request to the server-derived authorization server.
            expect(requestedUrls(fetchFn)).toEqual([sameOriginPrm]);
        });

        it('the warn-and-fall-back pass does not record the set-aside challenge URL, so a later restore from state succeeds', async () => {
            // First pass: the challenge relays a cross-origin URL; discovery warns,
            // falls back to the well-known derivation, and reaches the redirect.
            const saveDiscoveryState = vi.fn();
            const firstProvider = createProvider({
                discoveryState: vi.fn().mockResolvedValue(undefined),
                saveDiscoveryState
            });
            const firstFetch = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
                'https://auth.example.com/.well-known/': () => jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            const firstResult = await auth(firstProvider, {
                serverUrl: SERVER_URL,
                resourceMetadataUrl: new URL(CROSS_ORIGIN_PRM),
                resourceMetadataUrlSource: 'www-authenticate',
                fetchFn: firstFetch
            });
            expect(firstResult).toBe('REDIRECT');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('well-known'));
            const savedStates = saveDiscoveryState.mock.calls.map(call => call[0] as Record<string, unknown>);
            expect(savedStates.length).toBeGreaterThan(0);
            for (const state of savedStates) {
                expect(state.resourceMetadataUrl).toBeUndefined();
            }

            // Second pass: restore from a provider that persisted only the URLs
            // (metadata documents not round-tripped). Nothing recorded on the
            // first pass re-enters the flow as a caller-configured URL, so the
            // restored flow reaches the redirect again.
            const lastSaved = savedStates[savedStates.length - 1]!;
            const secondProvider = createProvider({
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: lastSaved.authorizationServerUrl,
                    resourceMetadataUrl: lastSaved.resourceMetadataUrl
                }),
                saveDiscoveryState: vi.fn()
            });
            const secondFetch = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
                'https://auth.example.com/.well-known/': () => jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            const secondResult = await auth(secondProvider, { serverUrl: SERVER_URL, fetchFn: secondFetch });
            expect(secondResult).toBe('REDIRECT');
            expect(requestedHosts(secondFetch)).not.toContain('other.example.com');
        });

        it('the same non-conformant URL configured by the caller fails the flow closed instead of falling back', async () => {
            const provider = createProvider();
            const fetchFn = vi.fn();

            await expect(
                auth(provider, { serverUrl: SERVER_URL, fetchFn, resourceMetadataUrl: new URL(CROSS_ORIGIN_PRM) })
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('a non-conformant resourceMetadataUrl restored from cached discovery state fails closed like a caller-configured one', async () => {
            // The cached restore is re-validated on every auth() call; a rejection
            // does not fall back to the well-known derivation.
            const provider = createProvider({
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: 'https://auth.example.com',
                    resourceMetadataUrl: CROSS_ORIGIN_PRM
                }),
                saveDiscoveryState: vi.fn()
            });
            const fetchFn = routedFetch({
                'https://auth.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            // The rejected URL is never requested, and there is no warn-and-fall-back
            // to the SDK's own well-known derivation.
            expect(requestedHosts(fetchFn)).not.toContain('other.example.com');
            expect(requestedUrls(fetchFn)).not.toContain(PRM_WELL_KNOWN);
            expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('well-known'));
        });
    });

    describe('endpoint validation from authorization server metadata', () => {
        it('registerClient rejects a non-loopback http registration endpoint before the request', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                registration_endpoint: 'http://auth.example.com/register'
            };
            const fetchFn = vi.fn();

            await expect(
                registerClient('https://auth.example.com', {
                    metadata,
                    clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] },
                    fetchFn
                })
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('registerClient rejects a loopback registration endpoint published by a remote authorization server', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                registration_endpoint: 'https://127.0.0.1:9000/register'
            };
            const fetchFn = vi.fn();

            await expect(
                registerClient('https://auth.example.com', {
                    metadata,
                    clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] },
                    fetchFn
                })
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('startAuthorization rejects a non-loopback http authorization endpoint (asserted, never requested)', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                authorization_endpoint: 'http://auth.example.com/authorize'
            };

            await expect(
                startAuthorization('https://auth.example.com', {
                    metadata,
                    clientInformation: { client_id: 'client-1' },
                    redirectUrl: 'http://localhost:3000/callback'
                })
            ).rejects.toThrow(DiscoveryUrlBlockedError);
        });

        it('startAuthorization keeps a loopback authorization server working without metadata', async () => {
            const { authorizationUrl } = await startAuthorization('http://localhost:9000', {
                clientInformation: { client_id: 'client-1' },
                redirectUrl: 'http://localhost:3000/callback'
            });
            expect(authorizationUrl.origin).toBe('http://localhost:9000');
        });
    });

    describe('token endpoint validation from authorization server metadata (RFC 6749)', () => {
        function exchangeOpts(metadata: AuthorizationServerMetadata, fetchFn: Mock) {
            return {
                metadata,
                clientInformation: { client_id: 'client-1' },
                authorizationCode: 'auth-code',
                codeVerifier: 'test_verifier',
                redirectUri: 'http://localhost:3000/callback',
                fetchFn
            };
        }

        it('rejects a loopback token endpoint published by a remote authorization server, before any request', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                token_endpoint: 'http://127.0.0.1:8845/token'
            };
            const fetchFn = vi.fn();

            await expect(exchangeAuthorization('https://auth.example.com', exchangeOpts(metadata, fetchFn))).rejects.toThrow(
                DiscoveryUrlBlockedError
            );
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('rejects a private-range https token endpoint (locality rule), before any request', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                token_endpoint: 'https://192.168.1.1/token'
            };
            const fetchFn = vi.fn();

            await expect(exchangeAuthorization('https://auth.example.com', exchangeOpts(metadata, fetchFn))).rejects.toThrow(
                DiscoveryUrlBlockedError
            );
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('refreshAuthorization applies the same validation before any request', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                token_endpoint: 'https://10.0.0.8/token'
            };
            const fetchFn = vi.fn();

            await expect(
                refreshAuthorization('https://auth.example.com', {
                    metadata,
                    clientInformation: { client_id: 'client-1' },
                    refreshToken: 'refresh-token',
                    fetchFn
                })
            ).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('allowPrivateAddressTargets permits a private-literal token endpoint explicitly', async () => {
            const metadata = {
                ...authServerMetadataFor('https://auth.example.com'),
                token_endpoint: 'https://10.0.0.8/token'
            };
            const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'token-1', token_type: 'bearer' }));

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                ...exchangeOpts(metadata, fetchFn),
                discoveryPolicy: { allowPrivateAddressTargets: true }
            });
            expect(tokens.access_token).toBe('token-1');
            expect(requestedUrls(fetchFn)).toEqual(['https://10.0.0.8/token']);
        });

        it('keeps a loopback authorization server with its loopback token endpoint working (local development)', async () => {
            const metadata = authServerMetadataFor('http://localhost:9000');
            const fetchFn = vi.fn(async () => jsonResponse({ access_token: 'token-1', token_type: 'bearer' }));

            const tokens = await exchangeAuthorization('http://localhost:9000', exchangeOpts(metadata, fetchFn));
            expect(tokens.access_token).toBe('token-1');
            expect(requestedUrls(fetchFn)).toEqual(['http://localhost:9000/token']);
        });

        it('a redirected token response is an error and the request is not re-sent (RFC 6749: token responses are terminal)', async () => {
            const metadata = authServerMetadataFor('https://auth.example.com');
            const fetchFn = vi.fn(
                async (_url: string | URL, _init?: RequestInit) =>
                    new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/token' } })
            );

            await expect(exchangeAuthorization('https://auth.example.com', exchangeOpts(metadata, fetchFn))).rejects.toThrow(/HTTP 307/);

            expect(fetchFn).toHaveBeenCalledTimes(1);
            expect(requestedUrls(fetchFn)).toEqual(['https://auth.example.com/token']);
            expect(fetchFn.mock.calls[0]![1]?.redirect).toBe('manual');
        });

        it('a filtered redirect on a token request fails with a message that does not point at the runtime', async () => {
            const metadata = authServerMetadataFor('https://auth.example.com');
            const fetchFn = vi.fn(async () => opaqueRedirectResponse());

            let caught: unknown;
            try {
                await exchangeAuthorization('https://auth.example.com', exchangeOpts(metadata, fetchFn));
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(RedirectFilteredResponseError);
            const filtered = caught as RedirectFilteredResponseError;
            expect(filtered.purpose).toBe('token-endpoint');
            expect(filtered.url.href).toBe('https://auth.example.com/token');
            // Redirected responses to these POSTs are terminal in every runtime, so
            // the message must not suggest a runtime change as a remedy.
            expect(filtered.message).toContain('never followed, in any runtime');
            expect(filtered.message).not.toContain('runtime that exposes redirect responses');
            expect(fetchFn).toHaveBeenCalledTimes(1);
        });

        it('a filtered redirect on a registration request fails the same way', async () => {
            const metadata = authServerMetadataFor('https://auth.example.com');
            const fetchFn = vi.fn(async () => opaqueRedirectResponse());

            await expect(
                registerClient('https://auth.example.com', {
                    metadata,
                    clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] },
                    fetchFn
                })
            ).rejects.toThrow(RedirectFilteredResponseError);
            expect(fetchFn).toHaveBeenCalledTimes(1);
        });

        it('a redirected registration response is an error and the request is not re-sent', async () => {
            const metadata = authServerMetadataFor('https://auth.example.com');
            const fetchFn = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
                redirectResponse(307, 'https://elsewhere.example.com/register')
            );

            await expect(
                registerClient('https://auth.example.com', {
                    metadata,
                    clientMetadata: { redirect_uris: ['http://localhost:3000/callback'] },
                    fetchFn
                })
            ).rejects.toThrow(RegistrationRejectedError);

            expect(fetchFn).toHaveBeenCalledTimes(1);
            expect(requestedUrls(fetchFn)).toEqual(['https://auth.example.com/register']);
            expect(fetchFn.mock.calls[0]![1]?.redirect).toBe('manual');
        });
    });

    describe('redirect handling on discovery requests', () => {
        it('requests discovery URLs with redirect: "manual" and follows a conformant hop', async () => {
            const redirected = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp/';
            const fetchFn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
                const urlString = url.toString();
                if (urlString === PRM_WELL_KNOWN) {
                    return redirectResponse(301, redirected);
                }
                if (urlString === redirected) {
                    return jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'));
                }
                throw new Error(`Unrouted fetch: ${urlString}`);
            });

            const metadata = await discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn);
            expect(metadata.resource).toBe(SERVER_URL);

            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN, redirected]);
            for (const call of fetchFn.mock.calls) {
                expect(call[1]?.redirect).toBe('manual');
            }
        });

        it('rejects a redirect hop that violates the policy, with zero requests to the hop target', async () => {
            const fetchFn = vi.fn(async (url: string | URL) => {
                if (url.toString() === PRM_WELL_KNOWN) {
                    return redirectResponse(302, 'http://169.254.169.254/latest/meta-data/');
                }
                throw new Error(`Unrouted fetch: ${url}`);
            });

            let caught: unknown;
            try {
                await discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(DiscoveryUrlBlockedError);
            const blocked = caught as DiscoveryUrlBlockedError;
            expect(blocked.context.purpose).toBe('redirect-hop');
            expect(blocked.context.redirectHop?.originalPurpose).toBe('resource-metadata');
            expect(blocked.context.redirectHop?.status).toBe(302);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('a filtered redirect on the derived well-known probes is fallback-eligible like a 404 and surfaces when no probe answers', async () => {
            const fetchFn = vi.fn(async () => opaqueRedirectResponse());

            let caught: unknown;
            try {
                await discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(RedirectFilteredResponseError);
            const filtered = caught as RedirectFilteredResponseError;
            expect(filtered.purpose).toBe('resource-metadata');
            expect(filtered.message).toContain('redirect target cannot be observed');
            // The path-aware probe's filtered redirect is treated like a 404: the
            // root probe is still attempted before the failure surfaces. No
            // redirect is ever followed — the responses carry no readable Location.
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN, 'https://mcp.example.com/.well-known/oauth-protected-resource']);
        });

        it('a filtered redirect that falls back to a retrievable root document does not surface at all', async () => {
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => opaqueRedirectResponse(),
                'https://mcp.example.com/.well-known/oauth-protected-resource': () =>
                    jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'))
            });

            const metadata = await discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn);
            expect(metadata.resource).toBe(SERVER_URL);
        });

        it('a filtered redirect on a followed hop reports the hop stage, like other hop-level failures', async () => {
            const callerPrm = 'https://mcp.example.com/custom-prm';
            const sameOriginHop = 'https://mcp.example.com/prm-moved';
            const fetchFn = vi.fn(async (url: string | URL) => {
                if (url.toString() === callerPrm) {
                    return redirectResponse(307, sameOriginHop);
                }
                return opaqueRedirectResponse();
            });

            let caught: unknown;
            try {
                await discoverOAuthProtectedResourceMetadata(SERVER_URL, { resourceMetadataUrl: callerPrm }, fetchFn);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(RedirectFilteredResponseError);
            const filtered = caught as RedirectFilteredResponseError;
            expect(filtered.purpose).toBe('redirect-hop');
            expect(filtered.url.href).toBe(sameOriginHop);
            // The hop that answered with the filtered redirect; its target is not
            // observable, so `from` names the answering URL and `status` is the
            // filtered response's literal 0.
            expect(filtered.redirectHop?.from.href).toBe(sameOriginHop);
            expect(filtered.redirectHop?.status).toBe(0);
            expect(filtered.redirectHop?.originalPurpose).toBe('resource-metadata');
            expect(requestedUrls(fetchFn)).toEqual([callerPrm, sameOriginHop]);
        });

        it('a filtered redirect on the derived probe degrades discoverOAuthServerInfo to the legacy fallback, like a 404', async () => {
            const fetchFn = routedFetch({
                'https://mcp.example.com/.well-known/oauth-protected-resource': () => opaqueRedirectResponse(),
                'https://mcp.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://mcp.example.com'))
            });

            const info = await discoverOAuthServerInfo(SERVER_URL, { fetchFn });

            expect(info.resourceMetadata).toBeUndefined();
            expect(info.authorizationServerUrl).toBe('https://mcp.example.com/');
            expect(info.authorizationServerMetadata?.issuer).toBe('https://mcp.example.com');
        });

        it('an authorization-server metadata candidate that answers with a filtered redirect is skipped, like a 404', async () => {
            const fetchFn = routedFetch({
                'https://auth.example.com/.well-known/oauth-authorization-server': () => opaqueRedirectResponse(),
                'https://auth.example.com/.well-known/openid-configuration': () =>
                    jsonResponse({
                        ...authServerMetadataFor('https://auth.example.com'),
                        jwks_uri: 'https://auth.example.com/jwks',
                        subject_types_supported: ['public'],
                        id_token_signing_alg_values_supported: ['RS256']
                    })
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com', { fetchFn });

            expect(metadata?.issuer).toBe('https://auth.example.com');
            expect(requestedUrls(fetchFn)).toEqual([
                'https://auth.example.com/.well-known/oauth-authorization-server',
                'https://auth.example.com/.well-known/openid-configuration'
            ]);
        });

        it('a deployment whose web tier answers every well-known path with a redirect still reaches the authorization redirect', async () => {
            // The full degradation chain in one flow: the protected-resource probe
            // and every authorization-server metadata candidate answer with
            // filtered redirects, so discovery degrades to the legacy
            // server-derived authorization server with its default endpoint paths.
            const provider = createProvider();
            const fetchFn = routedFetch({
                'https://mcp.example.com/.well-known/': () => opaqueRedirectResponse()
            });

            const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn });

            expect(result).toBe('REDIRECT');
            expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
            const redirectTarget = (provider.redirectToAuthorization as Mock).mock.calls[0]![0] as URL;
            expect(redirectTarget.origin).toBe('https://mcp.example.com');
            expect(redirectTarget.pathname).toBe('/authorize');
        });

        it('stops following after three hops and surfaces the remaining redirect response', async () => {
            let counter = 0;
            const fetchFn = vi.fn(async () => {
                counter += 1;
                return redirectResponse(302, `https://mcp.example.com/hop-${counter}`);
            });

            await expect(discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn)).rejects.toThrow('HTTP 302');
            // Initial request plus at most three followed hops.
            expect(fetchFn).toHaveBeenCalledTimes(4);
        });

        it('drops request headers when a hop leaves the current origin', async () => {
            const crossOriginTarget = 'https://cdn.example.com/oauth-protected-resource.json';
            const fetchFn = vi.fn(async (url: string | URL, _init?: RequestInit) => {
                if (url.toString() === PRM_WELL_KNOWN) {
                    return redirectResponse(307, crossOriginTarget);
                }
                if (url.toString() === crossOriginTarget) {
                    return jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'));
                }
                throw new Error(`Unrouted fetch: ${url}`);
            });

            await discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn);

            const [firstCall, secondCall] = fetchFn.mock.calls;
            expect(normalizeHeaders(firstCall![1]?.headers)).not.toEqual({});
            // The cross-origin request carries the sentinel so that a wrapping
            // fetch (createFetchWithInit) does not fall back to its base headers.
            expect(secondCall![1]?.headers).toBe(OMIT_BASE_HEADERS);
        });

        it('base headers from a wrapping fetch stay on same-origin hops but are dropped when a hop leaves the origin', async () => {
            const sameOriginHop = 'https://mcp.example.com/prm-moved';
            const crossOriginTarget = 'https://cdn.example.com/oauth-protected-resource.json';
            const innerFetch = vi.fn(async (url: string | URL, _init?: RequestInit) => {
                const urlString = url.toString();
                if (urlString === PRM_WELL_KNOWN) {
                    return redirectResponse(307, sameOriginHop);
                }
                if (urlString === sameOriginHop) {
                    return redirectResponse(307, crossOriginTarget);
                }
                if (urlString === crossOriginTarget) {
                    return jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com'));
                }
                throw new Error(`Unrouted fetch: ${url}`);
            });
            // The shape the transports build for oauthRequestInit: a wrapper that
            // merges base headers into every request it issues.
            const fetchFn = createFetchWithInit(innerFetch, { headers: { 'x-auth-gateway': 'gateway-value' } });

            await discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn);

            const headersPerRequest = innerFetch.mock.calls.map(call => normalizeHeaders(call[1]?.headers));
            expect(headersPerRequest).toHaveLength(3);
            expect(headersPerRequest[0]!['x-auth-gateway']).toBe('gateway-value');
            expect(headersPerRequest[1]!['x-auth-gateway']).toBe('gateway-value');
            // Headers never travel across origins on a redirect — the base headers
            // are not re-applied on the cross-origin request either.
            expect(headersPerRequest[2]).toEqual({});
        });

        it('a rejected hop on the protected-resource-metadata request fails discoverOAuthServerInfo closed (no legacy fallback)', async () => {
            const fetchFn = vi.fn(async (url: string | URL) => {
                if (url.toString() === PRM_WELL_KNOWN) {
                    return redirectResponse(302, 'http://192.168.1.10/prm');
                }
                throw new Error(`Unrouted fetch: ${url}`);
            });

            await expect(discoverOAuthServerInfo(SERVER_URL, { fetchFn })).rejects.toThrow(DiscoveryUrlBlockedError);
            // Fail closed: no fallback request to the server-derived authorization server.
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN]);
        });

        it('re-validates hops on authorization server metadata discovery as well', async () => {
            const asWellKnown = 'https://auth.example.com/.well-known/oauth-authorization-server';
            const fetchFn = vi.fn(async (url: string | URL) => {
                if (url.toString() === asWellKnown) {
                    return redirectResponse(302, 'https://192.168.1.10/metadata');
                }
                return notFoundResponse();
            });

            await expect(discoverAuthorizationServerMetadata('https://auth.example.com', { fetchFn })).rejects.toThrow(
                DiscoveryUrlBlockedError
            );
            expect(requestedUrls(fetchFn)).toEqual([asWellKnown]);
        });
    });

    describe('validation inside the discovery fetch path', () => {
        it('discoverAuthorizationServerMetadata fails closed before any request when the derived discovery URL violates the policy', async () => {
            // A non-loopback http authorization server derives non-loopback http
            // discovery URLs; the fetch path rejects them before the first request.
            const fetchFn = vi.fn();

            await expect(discoverAuthorizationServerMetadata('http://as.example.com', { fetchFn })).rejects.toThrow(
                DiscoveryUrlBlockedError
            );
            expect(fetchFn).not.toHaveBeenCalled();
        });

        it('the root-fallback discovery request is validated in the fetch path too (a policy-violating hop off it is rejected)', async () => {
            const rootWellKnown = 'https://mcp.example.com/.well-known/oauth-protected-resource';
            const fetchFn = vi.fn(async (url: string | URL) => {
                if (url.toString() === PRM_WELL_KNOWN) {
                    return notFoundResponse();
                }
                if (url.toString() === rootWellKnown) {
                    return redirectResponse(302, 'http://192.168.1.10/prm');
                }
                throw new Error(`Unrouted fetch: ${url}`);
            });

            await expect(discoverOAuthProtectedResourceMetadata(SERVER_URL, undefined, fetchFn)).rejects.toThrow(DiscoveryUrlBlockedError);
            expect(requestedUrls(fetchFn)).toEqual([PRM_WELL_KNOWN, rootWellKnown]);
        });
    });

    describe('full flow shape', () => {
        it('an interactive flow against a cross-origin https authorization server proceeds to redirect (default policy)', async () => {
            const provider = createProvider({
                clientInformation: vi.fn().mockResolvedValue({ client_id: 'client-1' }),
                saveDiscoveryState: vi.fn(),
                discoveryState: vi.fn().mockResolvedValue(undefined)
            });
            const fetchFn = routedFetch({
                [PRM_WELL_KNOWN]: () => jsonResponse(resourceMetadataFor(SERVER_URL, 'https://auth.example.com')),
                'https://auth.example.com/.well-known/oauth-authorization-server': () =>
                    jsonResponse(authServerMetadataFor('https://auth.example.com'))
            });

            const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn });
            expect(result).toBe('REDIRECT');
            expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
        });
    });
});
