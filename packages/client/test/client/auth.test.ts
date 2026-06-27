import type {
    AuthorizationServerMetadata,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
    StoredOAuthClientInformation,
    StoredOAuthTokens
} from '@modelcontextprotocol/core-internal';
import { LATEST_PROTOCOL_VERSION, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';
import type { Mock } from 'vitest';
import { expect, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import {
    assertSecureTokenEndpoint,
    auth,
    AuthorizationServerMismatchError,
    buildDiscoveryUrls,
    computeScopeUnion,
    determineScope,
    discardIfIssuerMismatch,
    discoverAuthorizationServerMetadata,
    discoverOAuthMetadata,
    discoverOAuthProtectedResourceMetadata,
    discoverOAuthServerInfo,
    exchangeAuthorization,
    extractWWWAuthenticateParams,
    InsecureTokenEndpointError,
    isHttpsUrl,
    isStrictScopeSuperset,
    IssuerMismatchError,
    refreshAuthorization,
    registerClient,
    RegistrationRejectedError,
    resolveAuthorizationCallbackParams,
    resolveClientMetadata,
    selectClientAuthMethod,
    selectResourceURL,
    startAuthorization,
    UnauthorizedError,
    validateAuthorizationResponseIssuer,
    validateClientMetadataUrl
} from '../../src/client/auth';
import type { OAuthClientInformationContext, OAuthDiscoveryState } from '../../src/client/auth';
import { ClientCredentialsProvider, createPrivateKeyJwtAuth } from '../../src/client/authExtensions';

// Mock pkce-challenge
vi.mock('pkce-challenge', () => ({
    default: () => ({
        code_verifier: 'test_verifier',
        code_challenge: 'test_challenge'
    })
}));

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

/**
 * fetchWithCorsRetry gates its CORS-swallowing heuristic on the `CORS_IS_POSSIBLE` shim constant.
 * Tests run under the Node shim (`false`), so a fetch TypeError is treated as a real network error
 * and thrown instead of swallowed. Tests that specifically exercise the browser CORS retry path
 * call `withBrowserLikeEnvironment()` to flip the mocked constant to `true`. The `afterEach` hook
 * resets it so a failed assertion can't leak the override into later tests.
 */
let mockedCorsIsPossible = false;
vi.mock('@modelcontextprotocol/client/_shims', async importOriginal => {
    const actual = await importOriginal<typeof import('@modelcontextprotocol/client/_shims')>();
    return {
        ...actual,
        get CORS_IS_POSSIBLE() {
            return mockedCorsIsPossible;
        }
    };
});
function withBrowserLikeEnvironment(): void {
    mockedCorsIsPossible = true;
}

describe('OAuth Authorization', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });
    afterEach(() => {
        mockedCorsIsPossible = false;
    });

    describe('extractWWWAuthenticateParams', () => {
        it('returns resource metadata url when present', async () => {
            const resourceUrl = 'https://resource.example.com/.well-known/oauth-protected-resource';
            const mockResponse = {
                headers: {
                    get: vi.fn(name => (name === 'WWW-Authenticate' ? `Bearer realm="mcp", resource_metadata="${resourceUrl}"` : null))
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({ resourceMetadataUrl: new URL(resourceUrl) });
        });

        it('returns scope when present', async () => {
            const scope = 'read';
            const mockResponse = {
                headers: {
                    get: vi.fn(name => (name === 'WWW-Authenticate' ? `Bearer realm="mcp", scope="${scope}"` : null))
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({ scope: scope });
        });

        it('returns empty object if not bearer', async () => {
            const resourceUrl = 'https://resource.example.com/.well-known/oauth-protected-resource';
            const scope = 'read';
            const mockResponse = {
                headers: {
                    get: vi.fn(name =>
                        name === 'WWW-Authenticate' ? `Basic realm="mcp", resource_metadata="${resourceUrl}", scope="${scope}"` : null
                    )
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({});
        });

        it('returns empty object if resource_metadata and scope not present', async () => {
            const mockResponse = {
                headers: {
                    get: vi.fn(name => (name === 'WWW-Authenticate' ? `Bearer realm="mcp"` : null))
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({});
        });

        it('returns undefined resourceMetadataUrl on invalid url', async () => {
            const resourceUrl = 'invalid-url';
            const scope = 'read';
            const mockResponse = {
                headers: {
                    get: vi.fn(name =>
                        name === 'WWW-Authenticate' ? `Bearer realm="mcp", resource_metadata="${resourceUrl}", scope="${scope}"` : null
                    )
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({ scope: scope });
        });

        it('returns error when present', async () => {
            const mockResponse = {
                headers: {
                    get: vi.fn(name => (name === 'WWW-Authenticate' ? `Bearer error="insufficient_scope", scope="admin"` : null))
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({ error: 'insufficient_scope', scope: 'admin' });
        });

        it('parses invalid_token challenges with protected resource metadata', async () => {
            const resourceUrl = 'https://resource.example.com/.well-known/oauth-protected-resource/mcp';
            const mockResponse = {
                headers: {
                    get: vi.fn(name =>
                        name === 'WWW-Authenticate'
                            ? `Bearer resource_metadata="${resourceUrl}", error="invalid_token", error_description="The access token expired"`
                            : null
                    )
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({
                resourceMetadataUrl: new URL(resourceUrl),
                error: 'invalid_token',
                errorDescription: 'The access token expired'
            });
        });

        it('returns error_description when present', async () => {
            const mockResponse = {
                headers: {
                    get: vi.fn(name =>
                        name === 'WWW-Authenticate'
                            ? `Bearer error="insufficient_scope", scope="admin", error_description="needs admin"`
                            : null
                    )
                }
            } as unknown as Response;

            expect(extractWWWAuthenticateParams(mockResponse)).toEqual({
                error: 'insufficient_scope',
                scope: 'admin',
                errorDescription: 'needs admin'
            });
        });
    });

    describe('computeScopeUnion', () => {
        it.each([
            { inputs: [undefined], expected: undefined },
            { inputs: [undefined, undefined], expected: undefined },
            { inputs: ['', '  '], expected: undefined },
            { inputs: ['read'], expected: 'read' },
            { inputs: ['read', undefined], expected: 'read' },
            { inputs: ['read write', 'write admin'], expected: 'read write admin' },
            { inputs: ['read', 'read'], expected: 'read' },
            { inputs: ['  read   write  ', 'admin'], expected: 'read write admin' },
            { inputs: ['a b', 'c', 'b d'], expected: 'a b c d' }
        ])('union of $inputs is $expected', ({ inputs, expected }) => {
            expect(computeScopeUnion(...inputs)).toBe(expected);
        });

        it('does not collapse hierarchical scopes', () => {
            // The spec explicitly does not require clients to deduplicate
            // hierarchically; the AS normalizes redundancy.
            expect(computeScopeUnion('admin', 'read')).toBe('admin read');
        });
    });

    describe('isStrictScopeSuperset', () => {
        it.each([
            { union: undefined, current: undefined, expected: false },
            { union: undefined, current: 'read', expected: false },
            { union: 'read', current: undefined, expected: true },
            { union: 'read', current: '', expected: true },
            { union: 'read', current: 'read', expected: false },
            { union: 'read write', current: 'read', expected: true },
            { union: 'read write', current: 'read write', expected: false },
            { union: 'read write', current: 'write read admin', expected: false },
            { union: 'read', current: 'read write', expected: false }
        ])('isStrictScopeSuperset($union, $current) is $expected', ({ union, current, expected }) => {
            expect(isStrictScopeSuperset(union, current)).toBe(expected);
        });
    });

    describe('discoverOAuthProtectedResourceMetadata', () => {
        const validMetadata = {
            resource: 'https://resource.example.com',
            authorization_servers: ['https://auth.example.com']
        };

        it('returns metadata when discovery succeeds', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com');
            expect(metadata).toEqual(validMetadata);
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1);
            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
        });

        it('returns metadata when first fetch fails but second without MCP header succeeds (browser CORS retry)', async () => {
            withBrowserLikeEnvironment();
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                return callCount === 1
                    ? Promise.reject(new TypeError('Network error'))
                    : Promise.resolve({
                          ok: true,
                          status: 200,
                          json: async () => validMetadata
                      });
            });

            // Should succeed with the second call
            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com');
            expect(metadata).toEqual(validMetadata);

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // Verify first call had MCP header
            expect(mockFetch.mock.calls[0]![1]?.headers).toHaveProperty('MCP-Protocol-Version');
        });

        it('throws an error when all fetch attempts fail (browser, retry throws non-TypeError)', async () => {
            withBrowserLikeEnvironment();
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                return callCount === 1 ? Promise.reject(new TypeError('First failure')) : Promise.reject(new Error('Second failure'));
            });

            // Should fail with the second error
            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow('Second failure');

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('throws TypeError immediately in non-browser environments without retrying', async () => {
            // In Node.js/Workers, CORS doesn't exist — a TypeError from fetch is a real
            // network/config error (DNS failure, connection refused, invalid URL) and
            // should propagate rather than being silently swallowed.
            mockFetch.mockImplementation(() => Promise.reject(new TypeError('getaddrinfo ENOTFOUND resource.example.com')));

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow(TypeError);

            // Only one call — no CORS retry attempted
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('throws on 404 errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow(
                'Resource server does not implement OAuth 2.0 Protected Resource Metadata.'
            );
        });

        it('throws on non-404 errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow('HTTP 500');
        });

        it('validates metadata schema', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    // Missing required fields
                    scopes_supported: ['email', 'mcp']
                })
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow();
        });

        it('returns metadata when discovery succeeds with path', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com/path/name');
            expect(metadata).toEqual(validMetadata);
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1);
            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource/path/name');
        });

        it('preserves query parameters in path-aware discovery', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com/path?param=value');
            expect(metadata).toEqual(validMetadata);
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1);
            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource/path?param=value');
        });

        it.each([400, 401, 403, 404, 410, 422, 429])(
            'falls back to root discovery when path-aware discovery returns %d',
            async statusCode => {
                // First call (path-aware) returns 4xx
                mockFetch.mockResolvedValueOnce({
                    ok: false,
                    status: statusCode
                });

                // Second call (root fallback) succeeds
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => validMetadata
                });

                const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com/path/name');
                expect(metadata).toEqual(validMetadata);

                const calls = mockFetch.mock.calls;
                expect(calls.length).toBe(2);

                // First call should be path-aware
                const [firstUrl, firstOptions] = calls[0]!;
                expect(firstUrl.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource/path/name');
                expect(firstOptions.headers).toEqual({
                    'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
                });

                // Second call should be root fallback
                const [secondUrl, secondOptions] = calls[1]!;
                expect(secondUrl.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
                expect(secondOptions.headers).toEqual({
                    'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
                });
            }
        );

        it('throws error when both path-aware and root discovery return 404', async () => {
            // First call (path-aware) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second call (root fallback) also returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com/path/name')).rejects.toThrow(
                'Resource server does not implement OAuth 2.0 Protected Resource Metadata.'
            );

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);
        });

        it('throws on 500 status without fallback', async () => {
            // First call (path-aware) returns 500 (overloaded server)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com/path/name')).rejects.toThrow('HTTP 500');

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback
        });

        it('falls back to root on 502 status for path URL', async () => {
            // First call (path-aware) returns 502 (reverse proxy routing error)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 502
            });

            // Root fallback also returns 502
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 502
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com/path/name')).rejects.toThrow('HTTP 502');

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2); // Should attempt root fallback for 502
        });

        it('does not fallback when the original URL is already at root path', async () => {
            // First call (path-aware for root) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com/')).rejects.toThrow(
                'Resource server does not implement OAuth 2.0 Protected Resource Metadata.'
            );

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback

            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
        });

        it('does not fallback when the original URL has no path', async () => {
            // First call (path-aware for no path) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow(
                'Resource server does not implement OAuth 2.0 Protected Resource Metadata.'
            );

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback

            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
        });

        it('falls back when path-aware discovery encounters CORS error (browser)', async () => {
            withBrowserLikeEnvironment();
            // First call (path-aware) fails with TypeError (CORS)
            mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError('CORS error')));

            // Retry path-aware without headers (simulating CORS retry)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second call (root fallback) succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com/deep/path');
            expect(metadata).toEqual(validMetadata);

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(3);

            // Final call should be root fallback
            const [lastUrl, lastOptions] = calls[2]!;
            expect(lastUrl.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
            expect(lastOptions.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('does not fallback when resourceMetadataUrl is provided', async () => {
            // Call with explicit URL returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            await expect(
                discoverOAuthProtectedResourceMetadata('https://resource.example.com/path', {
                    resourceMetadataUrl: 'https://custom.example.com/metadata'
                })
            ).rejects.toThrow('Resource server does not implement OAuth 2.0 Protected Resource Metadata.');

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback when explicit URL is provided

            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://custom.example.com/metadata');
        });

        it('supports overriding the fetch function used for requests', async () => {
            const validMetadata = {
                resource: 'https://resource.example.com',
                authorization_servers: ['https://auth.example.com']
            };

            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com', undefined, customFetch);

            expect(metadata).toEqual(validMetadata);
            expect(customFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).not.toHaveBeenCalled();

            const [url, options] = customFetch.mock.calls[0]!;
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
            expect(options.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });
    });

    describe('discoverOAuthMetadata', () => {
        const validMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
        };

        it('returns metadata when discovery succeeds', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com');
            expect(metadata).toEqual(validMetadata);
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1);
            const [url, options] = calls[0]!;
            expect(url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
            expect(options.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('returns metadata when discovery succeeds with path', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com/path/name');
            expect(metadata).toEqual(validMetadata);
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1);
            const [url, options] = calls[0]!;
            expect(url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/path/name');
            expect(options.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('falls back to root discovery when path-aware discovery returns 404', async () => {
            // First call (path-aware) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second call (root fallback) succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com/path/name');
            expect(metadata).toEqual(validMetadata);

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);

            // First call should be path-aware
            const [firstUrl, firstOptions] = calls[0]!;
            expect(firstUrl.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/path/name');
            expect(firstOptions.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });

            // Second call should be root fallback
            const [secondUrl, secondOptions] = calls[1]!;
            expect(secondUrl.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
            expect(secondOptions.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('returns undefined when both path-aware and root discovery return 404', async () => {
            // First call (path-aware) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second call (root fallback) also returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com/path/name');
            expect(metadata).toBeUndefined();

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);
        });

        it('does not fallback when the original URL is already at root path', async () => {
            // First call (path-aware for root) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com/');
            expect(metadata).toBeUndefined();

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback

            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
        });

        it('does not fallback when the original URL has no path', async () => {
            // First call (path-aware for no path) returns 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com');
            expect(metadata).toBeUndefined();

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback

            const [url] = calls[0]!;
            expect(url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
        });

        it('falls back when path-aware discovery encounters CORS error (browser)', async () => {
            withBrowserLikeEnvironment();
            // First call (path-aware) fails with TypeError (CORS)
            mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError('CORS error')));

            // Retry path-aware without headers (simulating CORS retry)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second call (root fallback) succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com/deep/path');
            expect(metadata).toEqual(validMetadata);

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(3);

            // Final call should be root fallback
            const [lastUrl, lastOptions] = calls[2]!;
            expect(lastUrl.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
            expect(lastOptions.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('returns metadata when first fetch fails but second without MCP header succeeds (browser CORS retry)', async () => {
            withBrowserLikeEnvironment();
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                return callCount === 1
                    ? Promise.reject(new TypeError('Network error'))
                    : Promise.resolve({
                          ok: true,
                          status: 200,
                          json: async () => validMetadata
                      });
            });

            // Should succeed with the second call
            const metadata = await discoverOAuthMetadata('https://auth.example.com');
            expect(metadata).toEqual(validMetadata);

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // Verify first call had MCP header
            expect(mockFetch.mock.calls[0]![1]?.headers).toHaveProperty('MCP-Protocol-Version');
        });

        it('throws an error when all fetch attempts fail (browser, retry throws non-TypeError)', async () => {
            withBrowserLikeEnvironment();
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                return callCount === 1 ? Promise.reject(new TypeError('First failure')) : Promise.reject(new Error('Second failure'));
            });

            // Should fail with the second error
            await expect(discoverOAuthMetadata('https://auth.example.com')).rejects.toThrow('Second failure');

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('returns undefined when both CORS requests fail in fetchWithCorsRetry (browser)', async () => {
            withBrowserLikeEnvironment();
            // fetchWithCorsRetry tries with headers (fails with CORS), then retries without headers (also fails with CORS)
            // simulating a 404 w/o headers set. We want this to return undefined, not throw TypeError
            mockFetch.mockImplementation(() => {
                // Both the initial request with headers and retry without headers fail with CORS TypeError
                return Promise.reject(new TypeError('Failed to fetch'));
            });

            // This should return undefined (the desired behavior after the fix)
            const metadata = await discoverOAuthMetadata('https://auth.example.com/path');
            expect(metadata).toBeUndefined();
        });

        it('returns undefined when discovery endpoint returns 404', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com');
            expect(metadata).toBeUndefined();
        });

        it('throws on non-404 errors for root URL', async () => {
            mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

            await expect(discoverOAuthMetadata('https://auth.example.com')).rejects.toThrow('HTTP 500');
        });

        it('falls back to root URL on 502 for path-aware discovery', async () => {
            // Path-aware URL returns 502 (reverse proxy has no route for well-known path)
            mockFetch.mockResolvedValueOnce(new Response(null, { status: 502 }));

            // Root fallback URL succeeds
            mockFetch.mockResolvedValueOnce(Response.json(validMetadata, { status: 200 }));

            const metadata = await discoverOAuthMetadata('https://auth.example.com/tenant1', {
                authorizationServerUrl: 'https://auth.example.com/tenant1'
            });

            expect(metadata).toEqual(validMetadata);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('does not fall back on non-502 5xx for path-aware discovery', async () => {
            // Path-aware URL returns 500 (overloaded server — should not retry)
            mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

            await expect(
                discoverOAuthMetadata('https://auth.example.com/tenant1', {
                    authorizationServerUrl: 'https://auth.example.com/tenant1'
                })
            ).rejects.toThrow('HTTP 500');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('throws when root fallback also returns error for path-aware discovery', async () => {
            // Path-aware URL returns 502 (gateway error — triggers fallback)
            mockFetch.mockResolvedValueOnce(new Response(null, { status: 502 }));

            // Root fallback also returns 503
            mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));

            await expect(
                discoverOAuthMetadata('https://auth.example.com/tenant1', {
                    authorizationServerUrl: 'https://auth.example.com/tenant1'
                })
            ).rejects.toThrow('HTTP 503');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('validates metadata schema', async () => {
            mockFetch.mockResolvedValueOnce(
                Response.json(
                    {
                        // Missing required fields
                        issuer: 'https://auth.example.com'
                    },
                    { status: 200 }
                )
            );

            await expect(discoverOAuthMetadata('https://auth.example.com')).rejects.toThrow();
        });

        it('supports overriding the fetch function used for requests', async () => {
            const validMetadata = {
                issuer: 'https://auth.example.com',
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
                registration_endpoint: 'https://auth.example.com/register',
                response_types_supported: ['code'],
                code_challenge_methods_supported: ['S256']
            };

            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => validMetadata
            });

            const metadata = await discoverOAuthMetadata('https://auth.example.com', {}, customFetch);

            expect(metadata).toEqual(validMetadata);
            expect(customFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).not.toHaveBeenCalled();

            const [url, options] = customFetch.mock.calls[0]!;
            expect(url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
            expect(options.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });
    });

    describe('buildDiscoveryUrls', () => {
        it('generates correct URLs for server without path', () => {
            const urls = buildDiscoveryUrls('https://auth.example.com');

            expect(urls).toHaveLength(2);
            expect(urls.map(u => ({ url: u.url.toString(), type: u.type }))).toEqual([
                {
                    url: 'https://auth.example.com/.well-known/oauth-authorization-server',
                    type: 'oauth'
                },
                {
                    url: 'https://auth.example.com/.well-known/openid-configuration',
                    type: 'oidc'
                }
            ]);
        });

        it('generates correct URLs for server with path', () => {
            const urls = buildDiscoveryUrls('https://auth.example.com/tenant1');

            expect(urls).toHaveLength(3);
            expect(urls.map(u => ({ url: u.url.toString(), type: u.type }))).toEqual([
                {
                    url: 'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
                    type: 'oauth'
                },
                {
                    url: 'https://auth.example.com/.well-known/openid-configuration/tenant1',
                    type: 'oidc'
                },
                {
                    url: 'https://auth.example.com/tenant1/.well-known/openid-configuration',
                    type: 'oidc'
                }
            ]);
        });

        it('handles URL object input', () => {
            const urls = buildDiscoveryUrls(new URL('https://auth.example.com/tenant1'));

            expect(urls).toHaveLength(3);
            expect(urls[0]!.url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/tenant1');
        });
    });

    describe('discoverAuthorizationServerMetadata', () => {
        const validOAuthMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
        };

        const validOpenIdMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            jwks_uri: 'https://auth.example.com/jwks',
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
        };

        it('tries URLs in order and returns first successful metadata', async () => {
            const tenantOidcMetadata = { ...validOpenIdMetadata, issuer: 'https://auth.example.com/tenant1' };
            // First OAuth URL (path before well-known) fails with 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second OIDC URL (path before well-known) succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => tenantOidcMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com/tenant1');

            expect(metadata).toEqual(tenantOidcMetadata);

            // Verify it tried the URLs in the correct order
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);
            expect(calls[0]![0].toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/tenant1');
            expect(calls[1]![0].toString()).toBe('https://auth.example.com/.well-known/openid-configuration/tenant1');
        });

        it('continues on 4xx errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400
            });

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validOpenIdMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com');

            expect(metadata).toEqual(validOpenIdMetadata);
        });

        it('preserves authorization_response_iss_parameter_supported through OIDC discovery parse', async () => {
            // OAuth well-known 404s; OIDC well-known returns metadata advertising RFC 9207 support.
            // Regression-guard: OpenIdProviderDiscoveryMetadataSchema is a plain z.object(), so the
            // field must be declared on the underlying schemas or it gets stripped — making the
            // RFC 9207 §2.4 advertised-but-missing reject inert on the OIDC-only discovery path.
            mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ...validOpenIdMetadata, authorization_response_iss_parameter_supported: true })
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com');

            expect(metadata?.authorization_response_iss_parameter_supported).toBe(true);
        });

        it('continues on 502 and tries next URL', async () => {
            // First URL (OAuth) returns 502 (reverse proxy with no route)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 502,
                text: async () => ''
            });

            // Second URL (OIDC) succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validOpenIdMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com');

            expect(metadata).toEqual(validOpenIdMetadata);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('throws on non-502 5xx errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => ''
            });

            await expect(discoverAuthorizationServerMetadata('https://auth.example.com')).rejects.toThrow('HTTP 500');
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('returns undefined when all URLs fail with 502', async () => {
            // All URLs return 502
            mockFetch.mockResolvedValue({
                ok: false,
                status: 502,
                text: async () => ''
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com/tenant1');

            expect(metadata).toBeUndefined();
        });

        it('handles CORS errors with retry (browser)', async () => {
            withBrowserLikeEnvironment();
            // First call fails with CORS
            mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError('CORS error')));

            // Retry without headers succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validOAuthMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com');

            expect(metadata).toEqual(validOAuthMetadata);
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);

            // First call should have headers
            expect(calls[0]![1]?.headers).toHaveProperty('MCP-Protocol-Version');

            // Second call should not have headers (CORS retry)
            expect(calls[1]![1]?.headers).toBeUndefined();
        });

        it('supports custom fetch function', async () => {
            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => validOAuthMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com', { fetchFn: customFetch });

            expect(metadata).toEqual(validOAuthMetadata);
            expect(customFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('supports custom protocol version', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validOAuthMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com', { protocolVersion: '2025-01-01' });

            expect(metadata).toEqual(validOAuthMetadata);
            const calls = mockFetch.mock.calls;
            const [, options] = calls[0]!;
            expect(options.headers).toEqual({
                'MCP-Protocol-Version': '2025-01-01',
                Accept: 'application/json'
            });
        });

        it('returns undefined when all URLs fail with CORS errors (browser)', async () => {
            withBrowserLikeEnvironment();
            // All fetch attempts fail with CORS errors (TypeError)
            mockFetch.mockImplementation(() => Promise.reject(new TypeError('CORS error')));

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com/tenant1');

            expect(metadata).toBeUndefined();

            // Verify that all discovery URLs were attempted
            expect(mockFetch).toHaveBeenCalledTimes(6); // 3 URLs × 2 attempts each (with and without headers)
        });

        it('throws TypeError in non-browser environments instead of silently falling through (network failure)', async () => {
            // In Node.js, a TypeError from fetch is a real error (DNS/connection), not CORS.
            // Swallowing it and returning undefined would cause the caller to silently fall
            // through to the next discovery URL, masking the actual network failure.
            mockFetch.mockImplementation(() => Promise.reject(new TypeError('getaddrinfo ENOTFOUND auth.example.com')));

            await expect(discoverAuthorizationServerMetadata('https://auth.example.com/tenant1')).rejects.toThrow(TypeError);

            // Only one call — no CORS retry attempted in non-browser environments
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        describe('RFC 8414 §3.3 issuer-echo validation', () => {
            it('rejects metadata whose issuer does not match the discovery input', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({ ...validOAuthMetadata, issuer: 'https://honest.example.com' })
                });

                const err = await discoverAuthorizationServerMetadata('https://attacker.example.com').catch(e => e);
                expect(err).toBeInstanceOf(IssuerMismatchError);
                expect(err).not.toBeInstanceOf(OAuthError);
                expect(err.kind).toBe('metadata');
                expect(err.expected).toBe('https://attacker.example.com');
                expect(err.received).toBe('https://honest.example.com');
            });

            it('rejects when metadata issuer matches a different tenant on the same host', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({ ...validOAuthMetadata, issuer: 'https://auth.example.com/tenant2' })
                });

                await expect(discoverAuthorizationServerMetadata('https://auth.example.com/tenant1')).rejects.toThrow(IssuerMismatchError);
            });

            it('accepts when issuer matches the discovery input exactly', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => validOAuthMetadata
                });

                await expect(discoverAuthorizationServerMetadata('https://auth.example.com')).resolves.toEqual(validOAuthMetadata);
            });

            it('tolerates a trailing slash on the SDK-synthesized discovery input only', async () => {
                // The legacy-fallback path synthesizes `String(new URL('/', serverUrl))` which always ends in `/`.
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => validOAuthMetadata // issuer: 'https://auth.example.com'
                });
                await expect(discoverAuthorizationServerMetadata('https://auth.example.com/')).resolves.toEqual(validOAuthMetadata);

                // The tolerance is one-directional: a slash on the *received* side is still a mismatch.
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({ ...validOAuthMetadata, issuer: 'https://auth.example.com/' })
                });
                await expect(discoverAuthorizationServerMetadata('https://auth.example.com')).rejects.toThrow(IssuerMismatchError);
            });

            it('skipIssuerValidation suppresses the check', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({ ...validOAuthMetadata, issuer: 'https://honest.example.com' })
                });

                await expect(
                    discoverAuthorizationServerMetadata('https://attacker.example.com', { skipIssuerValidation: true })
                ).resolves.toMatchObject({ issuer: 'https://honest.example.com' });
            });
        });
    });

    describe('validateAuthorizationResponseIssuer', () => {
        const expectedIssuer = 'https://auth.example.com';

        // The spec's four-row decision table.
        it.each([
            { label: 'row 1: supported + present + match → proceed', supported: true, iss: expectedIssuer, throws: false },
            { label: 'row 1: supported + present + mismatch → reject', supported: true, iss: 'https://attacker.example', throws: true },
            { label: 'row 2: supported + absent → reject', supported: true, iss: undefined, throws: true },
            { label: 'row 3: not advertised + present + match → proceed', supported: false, iss: expectedIssuer, throws: false },
            {
                label: 'row 3: not advertised + present + mismatch → reject',
                supported: false,
                iss: 'https://attacker.example',
                throws: true
            },
            { label: 'row 4: not advertised + absent → proceed', supported: false, iss: undefined, throws: false }
        ])('$label', ({ supported, iss, throws }) => {
            const run = () => validateAuthorizationResponseIssuer({ iss, expectedIssuer, issParameterSupported: supported });
            if (throws) {
                expect(run).toThrow(IssuerMismatchError);
                try {
                    run();
                } catch (e) {
                    expect((e as IssuerMismatchError).kind).toBe('authorization_response');
                }
            } else {
                expect(run).not.toThrow();
            }
        });

        // Forbidden normalizations: every one of these MUST be a mismatch even though
        // the values are URL-equivalent under RFC 3986 §6.2.2-6.2.3.
        it.each([
            { label: 'scheme case', iss: 'HTTPS://auth.example.com' },
            { label: 'host case', iss: 'https://AUTH.example.com' },
            { label: 'default port elision', iss: 'https://auth.example.com:443' },
            { label: 'trailing slash', iss: 'https://auth.example.com/' },
            { label: 'percent-encoding', iss: 'https://auth.example.co%6D' }
        ])('rejects on $label difference (no normalization applied)', ({ iss }) => {
            expect(() => validateAuthorizationResponseIssuer({ iss, expectedIssuer, issParameterSupported: true })).toThrow(
                IssuerMismatchError
            );
        });

        it('no-ops when there is no recorded issuer (no validated metadata)', () => {
            expect(() =>
                validateAuthorizationResponseIssuer({ iss: 'https://anything', expectedIssuer: undefined, issParameterSupported: true })
            ).not.toThrow();
            expect(() =>
                validateAuthorizationResponseIssuer({ iss: undefined, expectedIssuer: undefined, issParameterSupported: true })
            ).not.toThrow();
        });

        it('IssuerMismatchError JSON-encodes received value (log-injection guard)', () => {
            const err = new IssuerMismatchError('authorization_response', expectedIssuer, 'https://a\nINFO: forged');
            expect(err.message).not.toContain('\nINFO');
            expect(err.message).toContain(String.raw`https://a\nINFO: forged`);
        });
    });

    describe('resolveAuthorizationCallbackParams', () => {
        const issuer = 'https://auth.example.com';
        const provider = {
            discoveryState: async () => ({
                authorizationServerMetadata: {
                    issuer,
                    authorization_endpoint: `${issuer}/authorize`,
                    token_endpoint: `${issuer}/token`,
                    response_types_supported: ['code'],
                    authorization_response_iss_parameter_supported: true
                }
            })
        } as unknown as OAuthClientProvider;

        it('treats an empty ?code= as no-code (falls through to the error/neither diagnostic)', async () => {
            // URLSearchParams.get('code') returns '' (not null) for `?code=`, so a `!== null`
            // check would have POSTed `code=` to the token endpoint and lost the explicit
            // diagnostic. The truthy check restores the pre-PR behavior.
            await expect(
                resolveAuthorizationCallbackParams(new URLSearchParams(`code=&state=x&iss=${issuer}`), undefined, provider, issuer)
            ).rejects.toThrow(UnauthorizedError);
            // With an `error` param present, surfaces the gated OAuthError instead.
            await expect(
                resolveAuthorizationCallbackParams(
                    new URLSearchParams(`code=&error=access_denied&iss=${issuer}`),
                    undefined,
                    provider,
                    issuer
                )
            ).rejects.toThrow(OAuthError);
        });

        it('returns {authorizationCode, iss} when a non-empty code is present', async () => {
            await expect(
                resolveAuthorizationCallbackParams(new URLSearchParams(`code=abc&iss=${issuer}`), undefined, provider, issuer)
            ).resolves.toEqual({ authorizationCode: 'abc', iss: issuer });
        });
    });

    describe('discoverOAuthServerInfo', () => {
        const validResourceMetadata = {
            resource: 'https://resource.example.com',
            authorization_servers: ['https://auth.example.com']
        };

        const validAuthMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };

        it('returns auth server from RFC 9728 protected resource metadata', async () => {
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validResourceMetadata
                    });
                }

                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validAuthMetadata
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            const result = await discoverOAuthServerInfo('https://resource.example.com');

            expect(result.authorizationServerUrl).toBe('https://auth.example.com');
            expect(result.resourceMetadata).toEqual(validResourceMetadata);
            expect(result.authorizationServerMetadata).toEqual(validAuthMetadata);
        });

        it('falls back to server URL when RFC 9728 is not supported', async () => {
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                // RFC 9728 returns 404
                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: false,
                        status: 404
                    });
                }

                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            ...validAuthMetadata,
                            issuer: 'https://resource.example.com'
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            const result = await discoverOAuthServerInfo('https://resource.example.com');

            // Should fall back to server URL origin
            expect(result.authorizationServerUrl).toBe('https://resource.example.com/');
            expect(result.resourceMetadata).toBeUndefined();
            expect(result.authorizationServerMetadata).toBeDefined();
        });

        it('forwards resourceMetadataUrl override to protected resource metadata discovery', async () => {
            const overrideUrl = new URL('https://custom.example.com/.well-known/oauth-protected-resource');

            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString === overrideUrl.toString()) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validResourceMetadata
                    });
                }

                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validAuthMetadata
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            const result = await discoverOAuthServerInfo('https://resource.example.com', {
                resourceMetadataUrl: overrideUrl
            });

            expect(result.resourceMetadata).toEqual(validResourceMetadata);
            // Verify the override URL was used instead of the default well-known path
            expect(mockFetch.mock.calls[0]![0].toString()).toBe(overrideUrl.toString());
        });

        it('propagates network failures instead of silently falling back (non-browser)', async () => {
            // PRM discovery hits a DNS/connection failure. That's a transient reachability problem,
            // not "server doesn't support RFC 9728" — the caller should see the real error rather
            // than silently falling back to treating the MCP server URL as the auth server.
            mockFetch.mockImplementation(() => Promise.reject(new TypeError('getaddrinfo ENOTFOUND resource.example.com')));

            await expect(discoverOAuthServerInfo('https://resource.example.com')).rejects.toThrow(TypeError);
        });
    });

    describe('auth with provider authorization server URL caching', () => {
        const validResourceMetadata = {
            resource: 'https://resource.example.com',
            authorization_servers: ['https://auth.example.com']
        };

        const validAuthMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
        };

        function createMockProvider(overrides: Partial<OAuthClientProvider> = {}): OAuthClientProvider {
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
                codeVerifier: vi.fn(),
                ...overrides
            };
        }

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('calls saveDiscoveryState after discovery when provider implements it', async () => {
            const saveDiscoveryState = vi.fn();
            const provider = createMockProvider({ saveDiscoveryState });

            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validResourceMetadata
                    });
                }

                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validAuthMetadata
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            await auth(provider, { serverUrl: 'https://resource.example.com' });

            expect(saveDiscoveryState).toHaveBeenCalledWith(
                expect.objectContaining({
                    authorizationServerUrl: 'https://auth.example.com',
                    resourceMetadata: validResourceMetadata,
                    authorizationServerMetadata: validAuthMetadata
                })
            );
        });

        it('restores full discovery state from cache including resource metadata', async () => {
            const provider = createMockProvider({
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: 'https://auth.example.com',
                    resourceMetadata: validResourceMetadata,
                    authorizationServerMetadata: validAuthMetadata
                }),
                tokens: vi.fn().mockResolvedValue({
                    access_token: 'valid-token',
                    refresh_token: 'refresh-token',
                    token_type: 'bearer'
                })
            });

            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'new-token',
                            token_type: 'bearer',
                            expires_in: 3600,
                            refresh_token: 'new-refresh-token'
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            const result = await auth(provider, {
                serverUrl: 'https://resource.example.com'
            });

            expect(result).toBe('AUTHORIZED');

            // Should NOT have called any discovery endpoints -- all from cache
            const discoveryCalls = mockFetch.mock.calls.filter(
                call => call[0].toString().includes('oauth-protected-resource') || call[0].toString().includes('oauth-authorization-server')
            );
            expect(discoveryCalls).toHaveLength(0);

            // Verify the token request includes the resource parameter from cached metadata
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();
            const body = tokenCall![1].body as URLSearchParams;
            expect(body.get('resource')).toBe('https://resource.example.com');
        });

        it('re-saves enriched state when partial cache is supplemented with fetched metadata', async () => {
            const saveDiscoveryState = vi.fn();
            const provider = createMockProvider({
                // Partial cache: auth server URL only, no metadata
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: 'https://auth.example.com'
                }),
                saveDiscoveryState,
                tokens: vi.fn().mockResolvedValue({
                    access_token: 'valid-token',
                    refresh_token: 'refresh-token',
                    token_type: 'bearer'
                })
            });

            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validResourceMetadata
                    });
                }

                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validAuthMetadata
                    });
                }

                if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'new-token',
                            token_type: 'bearer',
                            expires_in: 3600,
                            refresh_token: 'new-refresh-token'
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            await auth(provider, { serverUrl: 'https://resource.example.com' });

            // Should re-save with the enriched state including fetched metadata
            expect(saveDiscoveryState).toHaveBeenCalledWith(
                expect.objectContaining({
                    authorizationServerUrl: 'https://auth.example.com',
                    authorizationServerMetadata: validAuthMetadata,
                    resourceMetadata: validResourceMetadata
                })
            );
        });

        it('uses resourceMetadataUrl from cached discovery state for PRM discovery', async () => {
            const cachedPrmUrl = 'https://custom.example.com/.well-known/oauth-protected-resource';
            const provider = createMockProvider({
                // Cache has auth server URL + resourceMetadataUrl but no resourceMetadata
                // (simulates browser redirect where PRM URL was saved but metadata wasn't)
                discoveryState: vi.fn().mockResolvedValue({
                    authorizationServerUrl: 'https://auth.example.com',
                    resourceMetadataUrl: cachedPrmUrl,
                    authorizationServerMetadata: validAuthMetadata
                }),
                tokens: vi.fn().mockResolvedValue({
                    access_token: 'valid-token',
                    refresh_token: 'refresh-token',
                    token_type: 'bearer'
                })
            });

            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                // The cached PRM URL should be used for resource metadata discovery
                if (urlString === cachedPrmUrl) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validResourceMetadata
                    });
                }

                if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'new-token',
                            token_type: 'bearer',
                            expires_in: 3600,
                            refresh_token: 'new-refresh-token'
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch: ${urlString}`));
            });

            const result = await auth(provider, {
                serverUrl: 'https://resource.example.com'
            });

            expect(result).toBe('AUTHORIZED');

            // Should have used the cached PRM URL, not the default well-known path
            const prmCalls = mockFetch.mock.calls.filter(call => call[0].toString().includes('oauth-protected-resource'));
            expect(prmCalls).toHaveLength(1);
            expect(prmCalls[0]![0].toString()).toBe(cachedPrmUrl);
        });
    });

    describe('selectClientAuthMethod', () => {
        it('selects the correct client authentication method from client information', () => {
            const clientInfo = {
                client_id: 'test-client-id',
                client_secret: 'test-client-secret',
                token_endpoint_auth_method: 'client_secret_basic'
            };
            const supportedMethods = ['client_secret_post', 'client_secret_basic', 'none'];
            const authMethod = selectClientAuthMethod(clientInfo, supportedMethods);
            expect(authMethod).toBe('client_secret_basic');
        });
        it('selects the correct client authentication method from supported methods', () => {
            const clientInfo = { client_id: 'test-client-id' };
            const supportedMethods = ['client_secret_post', 'client_secret_basic', 'none'];
            const authMethod = selectClientAuthMethod(clientInfo, supportedMethods);
            expect(authMethod).toBe('none');
        });
        it('defaults to client_secret_basic when server omits token_endpoint_auth_methods_supported (RFC 8414 §2)', () => {
            // RFC 8414 §2: if omitted, the default is client_secret_basic.
            // RFC 6749 §2.3.1: servers MUST support HTTP Basic for clients with a secret.
            const clientInfo = { client_id: 'test-client-id', client_secret: 'test-client-secret' };
            const authMethod = selectClientAuthMethod(clientInfo, []);
            expect(authMethod).toBe('client_secret_basic');
        });
        it('defaults to none for public clients when server omits token_endpoint_auth_methods_supported', () => {
            const clientInfo = { client_id: 'test-client-id' };
            const authMethod = selectClientAuthMethod(clientInfo, []);
            expect(authMethod).toBe('none');
        });
        it('honors DCR-returned token_endpoint_auth_method even when server metadata omits supported methods', () => {
            const clientInfo = {
                client_id: 'test-client-id',
                client_secret: 'test-client-secret',
                token_endpoint_auth_method: 'client_secret_post'
            };
            const authMethod = selectClientAuthMethod(clientInfo, []);
            expect(authMethod).toBe('client_secret_post');
        });
    });

    describe('selectResourceURL', () => {
        it('preserves the exact protected resource metadata resource indicator', async () => {
            const resource = await selectResourceURL('https://api.example.com/mcp-server', {} as OAuthClientProvider, {
                resource: 'https://api.example.com',
                authorization_servers: ['https://auth.example.com']
            });

            expect(resource).toBe('https://api.example.com');
        });
    });

    describe('startAuthorization', () => {
        const validMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/auth',
            token_endpoint: 'https://auth.example.com/tkn',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
        };

        const validOpenIdMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/auth',
            token_endpoint: 'https://auth.example.com/token',
            jwks_uri: 'https://auth.example.com/jwks',
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256']
        };

        const validClientInfo = {
            client_id: 'client123',
            client_secret: 'secret123',
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        it('generates authorization URL with PKCE challenge', async () => {
            const { authorizationUrl, codeVerifier } = await startAuthorization('https://auth.example.com', {
                metadata: undefined,
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback',
                resource: new URL('https://api.example.com/mcp-server')
            });

            expect(authorizationUrl.toString()).toMatch(/^https:\/\/auth\.example\.com\/authorize\?/);
            expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
            expect(authorizationUrl.searchParams.get('code_challenge')).toBe('test_challenge');
            expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
            expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://localhost:3000/callback');
            expect(authorizationUrl.searchParams.get('resource')).toBe('https://api.example.com/mcp-server');
            expect(codeVerifier).toBe('test_verifier');
        });

        it('preserves string resource indicators exactly', async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                metadata: undefined,
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback',
                resource: 'https://api.example.com'
            });

            expect(authorizationUrl.searchParams.get('resource')).toBe('https://api.example.com');
        });

        it('includes scope parameter when provided', async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback',
                scope: 'read write profile'
            });

            expect(authorizationUrl.searchParams.get('scope')).toBe('read write profile');
        });

        it('excludes scope parameter when not provided', async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback'
            });

            expect(authorizationUrl.searchParams.has('scope')).toBe(false);
        });

        it('includes state parameter when provided', async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback',
                state: 'foobar'
            });

            expect(authorizationUrl.searchParams.get('state')).toBe('foobar');
        });

        it('excludes state parameter when not provided', async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback'
            });

            expect(authorizationUrl.searchParams.has('state')).toBe(false);
        });

        // OpenID Connect requires that the user is prompted for consent if the scope includes 'offline_access'
        it("includes consent prompt parameter if scope includes 'offline_access'", async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback',
                scope: 'read write profile offline_access'
            });

            expect(authorizationUrl.searchParams.get('prompt')).toBe('consent');
        });

        it.each([validMetadata, validOpenIdMetadata])('uses metadata authorization_endpoint when provided', async baseMetadata => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                metadata: baseMetadata,
                clientInformation: validClientInfo,
                redirectUrl: 'http://localhost:3000/callback'
            });

            expect(authorizationUrl.toString()).toMatch(/^https:\/\/auth\.example\.com\/auth\?/);
        });

        it.each([validMetadata, validOpenIdMetadata])('validates response type support', async baseMetadata => {
            const metadata = {
                ...baseMetadata,
                response_types_supported: ['token'] // Does not support 'code'
            };

            await expect(
                startAuthorization('https://auth.example.com', {
                    metadata,
                    clientInformation: validClientInfo,
                    redirectUrl: 'http://localhost:3000/callback'
                })
            ).rejects.toThrow(/does not support response type/);
        });

        // https://github.com/modelcontextprotocol/typescript-sdk/issues/832
        it.each([validMetadata, validOpenIdMetadata])(
            'assumes supported code challenge methods includes S256 if absent',
            async baseMetadata => {
                const metadata = {
                    ...baseMetadata,
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: undefined
                };

                const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
                    metadata,
                    clientInformation: validClientInfo,
                    redirectUrl: 'http://localhost:3000/callback'
                });

                expect(authorizationUrl.toString()).toMatch(/^https:\/\/auth\.example\.com\/auth\?.+&code_challenge_method=S256/);
            }
        );

        it.each([validMetadata, validOpenIdMetadata])(
            'validates supported code challenge methods includes S256 if present',
            async baseMetadata => {
                const metadata = {
                    ...baseMetadata,
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['plain'] // Does not support 'S256'
                };

                await expect(
                    startAuthorization('https://auth.example.com', {
                        metadata,
                        clientInformation: validClientInfo,
                        redirectUrl: 'http://localhost:3000/callback'
                    })
                ).rejects.toThrow(/does not support code challenge method/);
            }
        );
    });

    describe('exchangeAuthorization', () => {
        const validTokens: OAuthTokens = {
            access_token: 'access123',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh123'
        };

        const validMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };

        const validClientInfo = {
            client_id: 'client123',
            client_secret: 'secret123',
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        it('exchanges code for tokens', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                codeVerifier: 'verifier123',
                redirectUri: 'http://localhost:3000/callback',
                resource: new URL('https://api.example.com/mcp-server')
            });

            expect(tokens).toEqual(validTokens);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({
                    href: 'https://auth.example.com/token'
                }),
                expect.objectContaining({
                    method: 'POST'
                })
            );

            const options = mockFetch.mock.calls[0]![1];
            expect(options.headers).toBeInstanceOf(Headers);
            expect(options.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            expect(options.body).toBeInstanceOf(URLSearchParams);

            const body = options.body as URLSearchParams;
            expect(body.get('grant_type')).toBe('authorization_code');
            expect(body.get('code')).toBe('code123');
            expect(body.get('code_verifier')).toBe('verifier123');
            // Default auth method is client_secret_basic when no metadata provided (RFC 8414 §2)
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
            expect(options.headers.get('Authorization')).toBe('Basic ' + btoa('client123:secret123'));
            expect(body.get('redirect_uri')).toBe('http://localhost:3000/callback');
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
        });

        it('preserves string resource indicators exactly in token requests', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            await exchangeAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                codeVerifier: 'verifier123',
                redirectUri: 'http://localhost:3000/callback',
                resource: 'https://api.example.com'
            });

            const options = mockFetch.mock.calls[0]![1];
            const body = options.body as URLSearchParams;
            expect(body.get('resource')).toBe('https://api.example.com');
        });

        it('allows for string "expires_in" values', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ...validTokens, expires_in: '3600' })
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                codeVerifier: 'verifier123',
                redirectUri: 'http://localhost:3000/callback',
                resource: new URL('https://api.example.com/mcp-server')
            });

            expect(tokens).toEqual(validTokens);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({
                    href: 'https://auth.example.com/token'
                }),
                expect.objectContaining({
                    method: 'POST'
                })
            );

            const options = mockFetch.mock.calls[0]![1];
            expect(options.headers).toBeInstanceOf(Headers);
            expect(options.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');

            const body = options.body as URLSearchParams;
            expect(body.get('grant_type')).toBe('authorization_code');
            expect(body.get('code')).toBe('code123');
            expect(body.get('code_verifier')).toBe('verifier123');
            // Default auth method is client_secret_basic when no metadata provided (RFC 8414 §2)
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
            expect(options.headers.get('Authorization')).toBe('Basic ' + btoa('client123:secret123'));
            expect(body.get('redirect_uri')).toBe('http://localhost:3000/callback');
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
        });
        it('exchanges code for tokens with auth', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                metadata: validMetadata,
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                codeVerifier: 'verifier123',
                redirectUri: 'http://localhost:3000/callback',
                addClientAuthentication: (
                    headers: Headers,
                    params: URLSearchParams,
                    url: string | URL,
                    metadata?: AuthorizationServerMetadata
                ) => {
                    headers.set('Authorization', 'Basic ' + btoa(validClientInfo.client_id + ':' + validClientInfo.client_secret));
                    params.set('example_url', typeof url === 'string' ? url : url.toString());
                    params.set('example_metadata', metadata?.authorization_endpoint ?? '');
                    params.set('example_param', 'example_value');
                }
            });

            expect(tokens).toEqual(validTokens);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({
                    href: 'https://auth.example.com/token'
                }),
                expect.objectContaining({
                    method: 'POST'
                })
            );

            const headers = mockFetch.mock.calls[0]![1].headers as Headers;
            expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            expect(headers.get('Authorization')).toBe('Basic Y2xpZW50MTIzOnNlY3JldDEyMw==');
            const body = mockFetch.mock.calls[0]![1].body as URLSearchParams;
            expect(body.get('grant_type')).toBe('authorization_code');
            expect(body.get('code')).toBe('code123');
            expect(body.get('code_verifier')).toBe('verifier123');
            expect(body.get('client_id')).toBeNull();
            expect(body.get('redirect_uri')).toBe('http://localhost:3000/callback');
            expect(body.get('example_url')).toBe('https://auth.example.com/token');
            expect(body.get('example_metadata')).toBe('https://auth.example.com/authorize');
            expect(body.get('example_param')).toBe('example_value');
            expect(body.get('client_secret')).toBeNull();
        });

        it('validates token response schema', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    // Missing required fields
                    access_token: 'access123'
                })
            });

            await expect(
                exchangeAuthorization('https://auth.example.com', {
                    clientInformation: validClientInfo,
                    authorizationCode: 'code123',
                    codeVerifier: 'verifier123',
                    redirectUri: 'http://localhost:3000/callback'
                })
            ).rejects.toThrow();
        });

        it('throws on error response', async () => {
            mockFetch.mockResolvedValueOnce(
                Response.json(new OAuthError(OAuthErrorCode.ServerError, 'Token exchange failed').toResponseObject(), { status: 400 })
            );

            await expect(
                exchangeAuthorization('https://auth.example.com', {
                    clientInformation: validClientInfo,
                    authorizationCode: 'code123',
                    codeVerifier: 'verifier123',
                    redirectUri: 'http://localhost:3000/callback'
                })
            ).rejects.toThrow('Token exchange failed');
        });

        it('supports overriding the fetch function used for requests', async () => {
            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                codeVerifier: 'verifier123',
                redirectUri: 'http://localhost:3000/callback',
                resource: new URL('https://api.example.com/mcp-server'),
                fetchFn: customFetch
            });

            expect(tokens).toEqual(validTokens);
            expect(customFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).not.toHaveBeenCalled();

            const [url, options] = customFetch.mock.calls[0]!;
            expect(url.toString()).toBe('https://auth.example.com/token');
            expect(options).toEqual(
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.any(Headers),
                    body: expect.any(URLSearchParams)
                })
            );

            const body = options.body as URLSearchParams;
            expect(body.get('grant_type')).toBe('authorization_code');
            expect(body.get('code')).toBe('code123');
            expect(body.get('code_verifier')).toBe('verifier123');
            // Default auth method is client_secret_basic when no metadata provided (RFC 8414 §2)
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
            expect((options.headers as Headers).get('Authorization')).toBe('Basic ' + btoa('client123:secret123'));
            expect(body.get('redirect_uri')).toBe('http://localhost:3000/callback');
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
        });
    });

    describe('refreshAuthorization', () => {
        const validTokens = {
            access_token: 'newaccess123',
            token_type: 'Bearer',
            expires_in: 3600
        };
        const validTokensWithNewRefreshToken = {
            ...validTokens,
            refresh_token: 'newrefresh123'
        };

        const validMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };

        const validClientInfo = {
            client_id: 'client123',
            client_secret: 'secret123',
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        it('exchanges refresh token for new tokens', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokensWithNewRefreshToken
            });

            const tokens = await refreshAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                refreshToken: 'refresh123',
                resource: new URL('https://api.example.com/mcp-server')
            });

            expect(tokens).toEqual(validTokensWithNewRefreshToken);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({
                    href: 'https://auth.example.com/token'
                }),
                expect.objectContaining({
                    method: 'POST'
                })
            );

            const headers = mockFetch.mock.calls[0]![1].headers as Headers;
            expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            const body = mockFetch.mock.calls[0]![1].body as URLSearchParams;
            expect(body.get('grant_type')).toBe('refresh_token');
            expect(body.get('refresh_token')).toBe('refresh123');
            // Default auth method is client_secret_basic when no metadata provided (RFC 8414 §2)
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
            expect(headers.get('Authorization')).toBe('Basic ' + btoa('client123:secret123'));
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
        });

        it('exchanges refresh token for new tokens with auth', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokensWithNewRefreshToken
            });

            const tokens = await refreshAuthorization('https://auth.example.com', {
                metadata: validMetadata,
                clientInformation: validClientInfo,
                refreshToken: 'refresh123',
                addClientAuthentication: (
                    headers: Headers,
                    params: URLSearchParams,
                    url: string | URL,
                    metadata?: AuthorizationServerMetadata
                ) => {
                    headers.set('Authorization', 'Basic ' + btoa(validClientInfo.client_id + ':' + validClientInfo.client_secret));
                    params.set('example_url', typeof url === 'string' ? url : url.toString());
                    params.set('example_metadata', metadata?.authorization_endpoint ?? '?');
                    params.set('example_param', 'example_value');
                }
            });

            expect(tokens).toEqual(validTokensWithNewRefreshToken);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({
                    href: 'https://auth.example.com/token'
                }),
                expect.objectContaining({
                    method: 'POST'
                })
            );

            const headers = mockFetch.mock.calls[0]![1].headers as Headers;
            expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            expect(headers.get('Authorization')).toBe('Basic Y2xpZW50MTIzOnNlY3JldDEyMw==');
            const body = mockFetch.mock.calls[0]![1].body as URLSearchParams;
            expect(body.get('grant_type')).toBe('refresh_token');
            expect(body.get('refresh_token')).toBe('refresh123');
            expect(body.get('client_id')).toBeNull();
            expect(body.get('example_url')).toBe('https://auth.example.com/token');
            expect(body.get('example_metadata')).toBe('https://auth.example.com/authorize');
            expect(body.get('example_param')).toBe('example_value');
            expect(body.get('client_secret')).toBeNull();
        });

        it('exchanges refresh token for new tokens and keep existing refresh token if none is returned', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const refreshToken = 'refresh123';
            const tokens = await refreshAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                refreshToken
            });

            expect(tokens).toEqual({ refresh_token: refreshToken, ...validTokens });
        });

        it('validates token response schema', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    // Missing required fields
                    access_token: 'newaccess123'
                })
            });

            await expect(
                refreshAuthorization('https://auth.example.com', {
                    clientInformation: validClientInfo,
                    refreshToken: 'refresh123'
                })
            ).rejects.toThrow();
        });

        it('throws on error response', async () => {
            mockFetch.mockResolvedValueOnce(
                Response.json(new OAuthError(OAuthErrorCode.ServerError, 'Token refresh failed').toResponseObject(), { status: 400 })
            );

            await expect(
                refreshAuthorization('https://auth.example.com', {
                    clientInformation: validClientInfo,
                    refreshToken: 'refresh123'
                })
            ).rejects.toThrow('Token refresh failed');
        });
    });

    describe('registerClient', () => {
        const validClientMetadata = {
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        const validClientInfo = {
            client_id: 'client123',
            client_secret: 'secret123',
            client_id_issued_at: 1_612_137_600,
            client_secret_expires_at: 1_612_224_000,
            ...validClientMetadata
        };

        function lastRegisterBody(): Record<string, unknown> {
            const call = mockFetch.mock.calls.at(-1);
            return JSON.parse(call![1].body as string) as Record<string, unknown>;
        }

        it('registers client and returns client information', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validClientInfo
            });

            const clientInfo = await registerClient('https://auth.example.com', {
                clientMetadata: validClientMetadata
            });

            expect(clientInfo).toEqual(validClientInfo);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({ href: 'https://auth.example.com/register' }),
                expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
            );
            expect(lastRegisterBody()).toMatchObject({
                redirect_uris: ['http://localhost:3000/callback'],
                client_name: 'Test Client'
            });
        });

        it('includes scope in registration body when provided, overriding clientMetadata.scope', async () => {
            const clientMetadataWithScope: OAuthClientMetadata = {
                ...validClientMetadata,
                scope: 'should-be-overridden'
            };

            const expectedClientInfo = {
                ...validClientInfo,
                scope: 'openid profile'
            };

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => expectedClientInfo
            });

            const clientInfo = await registerClient('https://auth.example.com', {
                clientMetadata: clientMetadataWithScope,
                scope: 'openid profile'
            });

            expect(clientInfo).toEqual(expectedClientInfo);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.objectContaining({ href: 'https://auth.example.com/register' }),
                expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
            );
            expect(lastRegisterBody()).toMatchObject({ ...validClientMetadata, scope: 'openid profile' });
        });

        it('POSTs the supplied clientMetadata verbatim (defaults are applied upstream by resolveClientMetadata)', async () => {
            mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => validClientInfo });
            await registerClient('https://auth.example.com', {
                clientMetadata: resolveClientMetadata({
                    clientMetadata: validClientMetadata,
                    redirectUrl: 'http://localhost:3000/callback'
                })
            });
            expect(lastRegisterBody()).toMatchObject({
                redirect_uris: ['http://localhost:3000/callback'],
                client_name: 'Test Client',
                application_type: 'native',
                grant_types: ['authorization_code', 'refresh_token']
            });
        });

        it('tolerates a non-enum application_type echoed by the AS (passes through, no throw)', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ ...validClientInfo, application_type: 'service' })
            });
            const info = await registerClient('https://auth.example.com', { clientMetadata: validClientMetadata });
            expect(info.application_type).toBe('service');
        });

        it('throws RegistrationRejectedError carrying status, body, and submitted metadata on rejection', async () => {
            const errorBody = JSON.stringify({ error: 'invalid_redirect_uri', error_description: 'http not permitted for web' });
            mockFetch.mockResolvedValueOnce(new Response(errorBody, { status: 400 }));

            const submitted = resolveClientMetadata({
                clientMetadata: { client_name: 't', redirect_uris: ['https://app.example.com/cb'] },
                redirectUrl: 'https://app.example.com/cb'
            });
            const err = await registerClient('https://auth.example.com', { clientMetadata: submitted }).catch(e => e as unknown);

            expect(err).toBeInstanceOf(RegistrationRejectedError);
            expect(err).not.toBeInstanceOf(OAuthError);
            const rre = err as RegistrationRejectedError;
            expect(rre.status).toBe(400);
            expect(rre.body).toBe(errorBody);
            expect(JSON.parse(rre.body).error).toBe(OAuthErrorCode.InvalidRedirectUri);
            // The submitted metadata echoes what was sent — including SDK-applied defaults.
            expect(rre.submittedMetadata.application_type).toBe('web');
            expect(rre.submittedMetadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
            expect(rre.submittedMetadata.redirect_uris).toEqual(['https://app.example.com/cb']);
        });

        it('validates client information response schema', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    // Missing required fields
                    client_secret: 'secret123'
                })
            });

            await expect(
                registerClient('https://auth.example.com', {
                    clientMetadata: validClientMetadata
                })
            ).rejects.toThrow();
        });

        it('throws when registration endpoint not available in metadata', async () => {
            const metadata = {
                issuer: 'https://auth.example.com',
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
                response_types_supported: ['code']
            };

            await expect(
                registerClient('https://auth.example.com', {
                    metadata,
                    clientMetadata: validClientMetadata
                })
            ).rejects.toThrow(/does not support dynamic client registration/);
        });

        it('throws on error response', async () => {
            mockFetch.mockResolvedValueOnce(
                Response.json(new OAuthError(OAuthErrorCode.ServerError, 'Dynamic client registration failed').toResponseObject(), {
                    status: 400
                })
            );

            await expect(
                registerClient('https://auth.example.com', {
                    clientMetadata: validClientMetadata
                })
            ).rejects.toThrow(/Dynamic client registration failed/i);
        });
    });

    describe('SEP-2207: token-endpoint https guard', () => {
        const clientInformation = { client_id: 'client123', client_secret: 'secret123' };

        it('assertSecureTokenEndpoint: throws on non-loopback http, returns URL for loopback', () => {
            expect(() => assertSecureTokenEndpoint('http://10.0.0.5/token')).toThrow(InsecureTokenEndpointError);
            expect(assertSecureTokenEndpoint('http://127.0.0.1:3000/token')).toBeInstanceOf(URL);
        });

        it('rejects a non-https token_endpoint before sending credentials', async () => {
            await expect(
                exchangeAuthorization('https://auth.example.com', {
                    metadata: {
                        issuer: 'https://auth.example.com',
                        authorization_endpoint: 'https://auth.example.com/authorize',
                        token_endpoint: 'http://auth.example.com/token',
                        response_types_supported: ['code']
                    },
                    clientInformation,
                    authorizationCode: 'code',
                    codeVerifier: 'verifier',
                    redirectUri: 'http://localhost:3000/callback'
                })
            ).rejects.toThrow(InsecureTokenEndpointError);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('rejects when the authorization-server URL fallback resolves to non-https', async () => {
            await expect(refreshAuthorization('http://auth.example.com', { clientInformation, refreshToken: 'rt' })).rejects.toThrow(
                InsecureTokenEndpointError
            );
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('propagates through auth() on the refresh branch instead of falling through to /authorize', async () => {
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();
                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({ ok: false, status: 404 });
                }
                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://api.example.com',
                            authorization_endpoint: 'https://api.example.com/authorize',
                            token_endpoint: 'http://api.example.com/token',
                            response_types_supported: ['code']
                        })
                    });
                }
                return Promise.resolve({ ok: false, status: 404 });
            });
            const redirectToAuthorization = vi.fn();
            const provider: OAuthClientProvider = {
                get redirectUrl() {
                    return 'http://localhost:3000/callback';
                },
                get clientMetadata() {
                    return { redirect_uris: ['http://localhost:3000/callback'] };
                },
                clientInformation: () => clientInformation,
                tokens: () => ({ access_token: 'old', token_type: 'Bearer', refresh_token: 'rt' }),
                saveTokens: vi.fn(),
                redirectToAuthorization,
                saveCodeVerifier: vi.fn(),
                codeVerifier: () => 'v'
            };

            await expect(auth(provider, { serverUrl: 'https://api.example.com/mcp' })).rejects.toThrow(InsecureTokenEndpointError);
            expect(redirectToAuthorization).not.toHaveBeenCalled();
            expect(mockFetch.mock.calls.some(c => c[0].toString().includes('/token'))).toBe(false);
        });

        it.each(['http://localhost:9001/token', 'http://127.0.0.1:9001/token', 'http://[::1]:9001/token'])(
            'permits loopback host %s',
            async tokenEndpoint => {
                mockFetch.mockResolvedValueOnce(Response.json({ access_token: 't', token_type: 'Bearer' }));
                await expect(
                    refreshAuthorization('http://localhost:9001', {
                        metadata: {
                            issuer: 'http://localhost:9001',
                            authorization_endpoint: 'http://localhost:9001/authorize',
                            token_endpoint: tokenEndpoint,
                            response_types_supported: ['code']
                        },
                        clientInformation,
                        refreshToken: 'rt'
                    })
                ).resolves.toBeDefined();
            }
        );
    });

    // SEP-2207 verify-only: behaviors already correct at the v2 baseline,
    // pinned here so a regression fails CI rather than the conformance referee.
    describe('SEP-2207: refresh-token guidance (verify-only pins)', () => {
        const clientInformation = { client_id: 'client123', client_secret: 'secret123' };

        it('does not assume a refresh_token is issued (optional in the token-response schema)', async () => {
            mockFetch.mockResolvedValueOnce(Response.json({ access_token: 't', token_type: 'Bearer' }));
            const tokens = await exchangeAuthorization('https://auth.example.com', {
                clientInformation,
                authorizationCode: 'code',
                codeVerifier: 'verifier',
                redirectUri: 'http://localhost:3000/callback'
            });
            expect(tokens.refresh_token).toBeUndefined();
        });

        it('keeps the prior refresh_token when the AS omits a replacement on refresh', async () => {
            mockFetch.mockResolvedValueOnce(Response.json({ access_token: 'new', token_type: 'Bearer' }));
            const tokens = await refreshAuthorization('https://auth.example.com', { clientInformation, refreshToken: 'rt-old' });
            expect(tokens.refresh_token).toBe('rt-old');
        });

        it('adopts a rotated refresh_token when the AS returns one', async () => {
            mockFetch.mockResolvedValueOnce(Response.json({ access_token: 'new', token_type: 'Bearer', refresh_token: 'rt-new' }));
            const tokens = await refreshAuthorization('https://auth.example.com', { clientInformation, refreshToken: 'rt-old' });
            expect(tokens.refresh_token).toBe('rt-new');
        });
    });

    describe('auth function', () => {
        const mockProvider: OAuthClientProvider = {
            get redirectUrl() {
                return 'http://localhost:3000/callback';
            },
            get clientMetadata() {
                return {
                    redirect_uris: ['http://localhost:3000/callback'],
                    client_name: 'Test Client'
                };
            },
            clientInformation: vi.fn(),
            tokens: vi.fn(),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn()
        };

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('performs client_credentials with private_key_jwt when provider has addClientAuthentication', async () => {
            // Arrange: metadata discovery for PRM and AS
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://api.example.com/mcp-server',
                            authorization_servers: ['https://auth.example.com']
                        })
                    });
                }

                if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                }

                if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'cc_jwt_token',
                            token_type: 'bearer',
                            expires_in: 3600
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch call: ${urlString}`));
            });

            // Create a provider with client_credentials grant and addClientAuthentication
            // redirectUrl returns undefined to indicate non-interactive flow
            const ccProvider: OAuthClientProvider = {
                get redirectUrl() {
                    // eslint-disable-next-line unicorn/no-useless-undefined
                    return undefined;
                },
                get clientMetadata() {
                    return {
                        redirect_uris: [],
                        client_name: 'Test Client',
                        grant_types: ['client_credentials']
                    };
                },
                clientInformation: vi.fn().mockResolvedValue({
                    client_id: 'client-id'
                }),
                tokens: vi.fn().mockResolvedValue(undefined),
                saveTokens: vi.fn().mockResolvedValue(undefined),
                redirectToAuthorization: vi.fn(),
                saveCodeVerifier: vi.fn(),
                codeVerifier: vi.fn(),
                prepareTokenRequest: () => new URLSearchParams({ grant_type: 'client_credentials' }),
                addClientAuthentication: createPrivateKeyJwtAuth({
                    issuer: 'client-id',
                    subject: 'client-id',
                    privateKey: 'a-string-secret-at-least-256-bits-long',
                    alg: 'HS256'
                })
            };

            const result = await auth(ccProvider, {
                serverUrl: 'https://api.example.com/mcp-server'
            });

            expect(result).toBe('AUTHORIZED');

            // Find the token request
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();

            const [, init] = tokenCall!;
            const body = init.body as URLSearchParams;

            // grant_type MUST be client_credentials, not the JWT-bearer grant
            expect(body.get('grant_type')).toBe('client_credentials');
            // private_key_jwt client authentication parameters
            expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
            expect(body.get('client_assertion')).toBeTruthy();
            // resource parameter included based on PRM
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
        });

        it('falls back to /.well-known/oauth-authorization-server when no protected-resource-metadata', async () => {
            // Setup: First call to protected resource metadata fails (404)
            // Second call to auth server metadata succeeds
            let callCount = 0;
            mockFetch.mockImplementation(url => {
                callCount++;

                const urlString = url.toString();

                if (callCount === 1 && urlString.includes('/.well-known/oauth-protected-resource')) {
                    // First call - protected resource metadata fails with 404
                    return Promise.resolve({
                        ok: false,
                        status: 404
                    });
                } else if (callCount === 2 && urlString.includes('/.well-known/oauth-authorization-server')) {
                    // Second call - auth server metadata succeeds
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://resource.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            registration_endpoint: 'https://auth.example.com/register',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (callCount === 3 && urlString.includes('/register')) {
                    // Third call - client registration succeeds
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            client_id: 'test-client-id',
                            client_secret: 'test-client-secret',
                            client_id_issued_at: 1_612_137_600,
                            client_secret_expires_at: 1_612_224_000,
                            redirect_uris: ['http://localhost:3000/callback'],
                            client_name: 'Test Client'
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch call: ${urlString}`));
            });

            // Mock provider methods
            (mockProvider.clientInformation as Mock).mockResolvedValue(undefined);
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            mockProvider.saveClientInformation = vi.fn();

            // Call the auth function
            const result = await auth(mockProvider, {
                serverUrl: 'https://resource.example.com'
            });

            // Verify the result
            expect(result).toBe('REDIRECT');

            // Verify the sequence of calls
            expect(mockFetch).toHaveBeenCalledTimes(3);

            // First call should be to protected resource metadata
            expect(mockFetch.mock.calls[0]![0].toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');

            // Second call should be to oauth metadata at the root path
            expect(mockFetch.mock.calls[1]![0].toString()).toBe('https://resource.example.com/.well-known/oauth-authorization-server');
        });

        it('uses base URL (with root path) as authorization server when protected-resource-metadata discovery fails', async () => {
            // Setup: First call to protected resource metadata fails (404)
            // When no authorization_servers are found in protected resource metadata,
            // the auth server URL should be set to the base URL with "/" path
            let callCount = 0;
            mockFetch.mockImplementation(url => {
                callCount++;

                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    // Protected resource metadata discovery attempts (both path-aware and root) fail with 404
                    return Promise.resolve({
                        ok: false,
                        status: 404
                    });
                } else if (urlString === 'https://resource.example.com/.well-known/oauth-authorization-server') {
                    // Should fetch from base URL with root path, not the full serverUrl path
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://resource.example.com/',
                            authorization_endpoint: 'https://resource.example.com/authorize',
                            token_endpoint: 'https://resource.example.com/token',
                            registration_endpoint: 'https://resource.example.com/register',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/register')) {
                    // Client registration succeeds
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            client_id: 'test-client-id',
                            client_secret: 'test-client-secret',
                            client_id_issued_at: 1_612_137_600,
                            client_secret_expires_at: 1_612_224_000,
                            redirect_uris: ['http://localhost:3000/callback'],
                            client_name: 'Test Client'
                        })
                    });
                }

                return Promise.reject(new Error(`Unexpected fetch call #${callCount}: ${urlString}`));
            });

            // Mock provider methods
            (mockProvider.clientInformation as Mock).mockResolvedValue(undefined);
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            mockProvider.saveClientInformation = vi.fn();

            // Call the auth function with a server URL that has a path
            const result = await auth(mockProvider, {
                serverUrl: 'https://resource.example.com/path/to/server'
            });

            // Verify the result
            expect(result).toBe('REDIRECT');

            // Verify that the oauth-authorization-server call uses the base URL
            // This proves the fix: using new URL("/", serverUrl) instead of serverUrl
            const authServerCall = mockFetch.mock.calls.find(call =>
                call[0].toString().includes('/.well-known/oauth-authorization-server')
            );
            expect(authServerCall).toBeDefined();
            expect(authServerCall![0].toString()).toBe('https://resource.example.com/.well-known/oauth-authorization-server');
        });

        it('passes resource parameter through authorization flow', async () => {
            // Mock successful metadata discovery - need to include protected resource metadata
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();
                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://api.example.com/mcp-server',
                            authorization_servers: ['https://auth.example.com']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                }
                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods for authorization flow
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth without authorization code (should trigger redirect)
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server'
            });

            expect(result).toBe('REDIRECT');

            // Verify the authorization URL includes the resource parameter
            expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
                expect.objectContaining({
                    searchParams: expect.any(URLSearchParams)
                })
            );

            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0]!;
            const authUrl: URL = redirectCall[0];
            expect(authUrl.searchParams.get('resource')).toBe('https://api.example.com/mcp-server');
        });

        it('includes resource in token exchange when authorization code is provided', async () => {
            // Mock successful metadata discovery and token exchange - need protected resource metadata
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://api.example.com/mcp-server',
                            authorization_servers: ['https://auth.example.com']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'access123',
                            token_type: 'Bearer',
                            expires_in: 3600,
                            refresh_token: 'refresh123'
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods for token exchange
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.codeVerifier as Mock).mockResolvedValue('test-verifier');
            (mockProvider.saveTokens as Mock).mockResolvedValue(undefined);

            // Call auth with authorization code
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server',
                authorizationCode: 'auth-code-123'
            });

            expect(result).toBe('AUTHORIZED');

            // Find the token exchange call
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();

            const body = tokenCall![1].body as URLSearchParams;
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
            expect(body.get('code')).toBe('auth-code-123');
        });

        it('includes resource in token refresh', async () => {
            // Mock successful metadata discovery and token refresh - need protected resource metadata
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://api.example.com/mcp-server',
                            authorization_servers: ['https://auth.example.com']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'new-access123',
                            token_type: 'Bearer',
                            expires_in: 3600
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods for token refresh
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue({
                access_token: 'old-access',
                refresh_token: 'refresh123'
            });
            (mockProvider.saveTokens as Mock).mockResolvedValue(undefined);

            // Call auth with existing tokens (should trigger refresh)
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server'
            });

            expect(result).toBe('AUTHORIZED');

            // Find the token refresh call
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();

            const body = tokenCall![1].body as URLSearchParams;
            expect(body.get('resource')).toBe('https://api.example.com/mcp-server');
            expect(body.get('grant_type')).toBe('refresh_token');
            expect(body.get('refresh_token')).toBe('refresh123');
        });

        it('skips default PRM resource validation when custom validateResourceURL is provided', async () => {
            const mockValidateResourceURL = vi.fn().mockResolvedValue(undefined);
            const providerWithCustomValidation = {
                ...mockProvider,
                validateResourceURL: mockValidateResourceURL
            };

            // Mock protected resource metadata with mismatched resource URL
            // This would normally throw an error in default validation, but should be skipped
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://different-resource.example.com/mcp-server', // Mismatched resource
                            authorization_servers: ['https://auth.example.com']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods
            (providerWithCustomValidation.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (providerWithCustomValidation.tokens as Mock).mockResolvedValue(undefined);
            (providerWithCustomValidation.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (providerWithCustomValidation.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth - should succeed despite resource mismatch because custom validation overrides default
            const result = await auth(providerWithCustomValidation, {
                serverUrl: 'https://api.example.com/mcp-server'
            });

            expect(result).toBe('REDIRECT');

            // Verify custom validation method was called
            expect(mockValidateResourceURL).toHaveBeenCalledWith(
                new URL('https://api.example.com/mcp-server'),
                'https://different-resource.example.com/mcp-server'
            );
        });

        it('uses prefix of server URL from PRM resource as resource parameter', async () => {
            // Mock successful metadata discovery with resource URL that is a prefix of requested URL
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            // Resource is a prefix of the requested server URL
                            resource: 'https://api.example.com/',
                            authorization_servers: ['https://auth.example.com']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth with a URL that has the resource as prefix
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server/endpoint'
            });

            expect(result).toBe('REDIRECT');

            // Verify the authorization URL includes the resource parameter from PRM
            expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
                expect.objectContaining({
                    searchParams: expect.any(URLSearchParams)
                })
            );

            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0]!;
            const authUrl: URL = redirectCall[0];
            // Should use the PRM's resource value, not the full requested URL
            expect(authUrl.searchParams.get('resource')).toBe('https://api.example.com/');
        });

        it('excludes resource parameter when Protected Resource Metadata is not present', async () => {
            // Mock metadata discovery where protected resource metadata is not available (404)
            // but authorization server metadata is available
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    // Protected resource metadata not available
                    return Promise.resolve({
                        ok: false,
                        status: 404
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://api.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth - should not include resource parameter
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server'
            });

            expect(result).toBe('REDIRECT');

            // Verify the authorization URL does NOT include the resource parameter
            expect(mockProvider.redirectToAuthorization).toHaveBeenCalledWith(
                expect.objectContaining({
                    searchParams: expect.any(URLSearchParams)
                })
            );

            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0]!;
            const authUrl: URL = redirectCall[0];
            // Resource parameter should not be present when PRM is not available
            expect(authUrl.searchParams.has('resource')).toBe(false);
        });

        it('excludes resource parameter in token exchange when Protected Resource Metadata is not present', async () => {
            // Mock metadata discovery - no protected resource metadata, but auth server metadata available
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: false,
                        status: 404
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://api.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'access123',
                            token_type: 'Bearer',
                            expires_in: 3600,
                            refresh_token: 'refresh123'
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods for token exchange
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.codeVerifier as Mock).mockResolvedValue('test-verifier');
            (mockProvider.saveTokens as Mock).mockResolvedValue(undefined);

            // Call auth with authorization code
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server',
                authorizationCode: 'auth-code-123'
            });

            expect(result).toBe('AUTHORIZED');

            // Find the token exchange call
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();

            const body = tokenCall![1].body as URLSearchParams;
            // Resource parameter should not be present when PRM is not available
            expect(body.has('resource')).toBe(false);
            expect(body.get('code')).toBe('auth-code-123');
        });

        it('excludes resource parameter in token refresh when Protected Resource Metadata is not present', async () => {
            // Mock metadata discovery - no protected resource metadata, but auth server metadata available
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: false,
                        status: 404
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://api.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/token')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            access_token: 'new-access123',
                            token_type: 'Bearer',
                            expires_in: 3600
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods for token refresh
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue({
                access_token: 'old-access',
                refresh_token: 'refresh123'
            });
            (mockProvider.saveTokens as Mock).mockResolvedValue(undefined);

            // Call auth with existing tokens (should trigger refresh)
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/mcp-server'
            });

            expect(result).toBe('AUTHORIZED');

            // Find the token refresh call
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();

            const body = tokenCall![1].body as URLSearchParams;
            // Resource parameter should not be present when PRM is not available
            expect(body.has('resource')).toBe(false);
            expect(body.get('grant_type')).toBe('refresh_token');
            expect(body.get('refresh_token')).toBe('refresh123');
        });

        it('uses scopes_supported from PRM when scope is not provided', async () => {
            // Mock PRM with scopes_supported
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://api.example.com/',
                            authorization_servers: ['https://auth.example.com'],
                            scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            registration_endpoint: 'https://auth.example.com/register',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/register')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            client_id: 'test-client-id',
                            client_secret: 'test-client-secret',
                            redirect_uris: ['http://localhost:3000/callback'],
                            client_name: 'Test Client'
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods - no scope in clientMetadata
            (mockProvider.clientInformation as Mock).mockResolvedValue(undefined);
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            mockProvider.saveClientInformation = vi.fn();
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth without scope parameter
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/'
            });

            expect(result).toBe('REDIRECT');

            // Verify the authorization URL includes the scopes from PRM
            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0]!;
            const authUrl: URL = redirectCall[0];
            expect(authUrl?.searchParams.get('scope')).toBe('mcp:read mcp:write mcp:admin');

            // Verify the same scope was also used in the DCR request body
            const registerCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/register'));
            expect(registerCall).toBeDefined();
            const registerBody = JSON.parse(registerCall![1].body as string);
            expect(registerBody.scope).toBe('mcp:read mcp:write mcp:admin');
        });

        it('prefers explicit scope parameter over scopes_supported from PRM', async () => {
            // Mock PRM with scopes_supported
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://api.example.com/',
                            authorization_servers: ['https://auth.example.com'],
                            scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin']
                        })
                    });
                } else if (urlString.includes('/.well-known/oauth-authorization-server')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            registration_endpoint: 'https://auth.example.com/register',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                } else if (urlString.includes('/register')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            client_id: 'test-client-id',
                            client_secret: 'test-client-secret',
                            redirect_uris: ['http://localhost:3000/callback'],
                            client_name: 'Test Client'
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods
            (mockProvider.clientInformation as Mock).mockResolvedValue(undefined);
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            mockProvider.saveClientInformation = vi.fn();
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth with explicit scope parameter
            const result = await auth(mockProvider, {
                serverUrl: 'https://api.example.com/',
                scope: 'mcp:read'
            });

            expect(result).toBe('REDIRECT');

            // Verify the authorization URL uses the explicit scope, not scopes_supported
            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0]!;
            const authUrl: URL = redirectCall[0];
            expect(authUrl.searchParams.get('scope')).toBe('mcp:read');
        });

        it('fetches AS metadata with path from serverUrl when PRM returns external AS', async () => {
            // Mock PRM discovery that returns an external AS
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString === 'https://my.resource.com/.well-known/oauth-protected-resource/path/name') {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://my.resource.com/',
                            authorization_servers: ['https://auth.example.com/oauth']
                        })
                    });
                } else if (urlString === 'https://auth.example.com/.well-known/oauth-authorization-server/path/name') {
                    // Path-aware discovery on AS with path from serverUrl
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                            code_challenge_methods_supported: ['S256']
                        })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            // Mock provider methods
            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);

            // Call auth with serverUrl that has a path
            const result = await auth(mockProvider, {
                serverUrl: 'https://my.resource.com/path/name'
            });

            expect(result).toBe('REDIRECT');

            // Verify the correct URLs were fetched
            const calls = mockFetch.mock.calls;

            // First call should be to PRM
            expect(calls[0]![0].toString()).toBe('https://my.resource.com/.well-known/oauth-protected-resource/path/name');

            // Second call should be to AS metadata with the path from authorization server
            expect(calls[1]![0].toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/oauth');
        });

        it('supports overriding the fetch function used for requests', async () => {
            const customFetch = vi.fn();

            // Mock PRM discovery
            customFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    resource: 'https://resource.example.com',
                    authorization_servers: ['https://auth.example.com']
                })
            });

            // Mock AS metadata discovery
            customFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://auth.example.com',
                    authorization_endpoint: 'https://auth.example.com/authorize',
                    token_endpoint: 'https://auth.example.com/token',
                    registration_endpoint: 'https://auth.example.com/register',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                })
            });

            const mockProvider: OAuthClientProvider = {
                get redirectUrl() {
                    return 'http://localhost:3000/callback';
                },
                get clientMetadata() {
                    return {
                        client_name: 'Test Client',
                        redirect_uris: ['http://localhost:3000/callback']
                    };
                },
                clientInformation: vi.fn().mockResolvedValue({
                    client_id: 'client123',
                    client_secret: 'secret123'
                }),
                tokens: vi.fn().mockResolvedValue(undefined),
                saveTokens: vi.fn(),
                redirectToAuthorization: vi.fn(),
                saveCodeVerifier: vi.fn(),
                codeVerifier: vi.fn().mockResolvedValue('verifier123')
            };

            const result = await auth(mockProvider, {
                serverUrl: 'https://resource.example.com',
                fetchFn: customFetch
            });

            expect(result).toBe('REDIRECT');
            expect(customFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch).not.toHaveBeenCalled();

            // Verify custom fetch was called for PRM discovery
            expect(customFetch.mock.calls[0]![0].toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');

            // Verify custom fetch was called for AS metadata discovery
            expect(customFetch.mock.calls[1]![0].toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
        });
    });

    describe('exchangeAuthorization with multiple client authentication methods', () => {
        const validTokens = {
            access_token: 'access123',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh123'
        };

        const validClientInfo = {
            client_id: 'client123',
            client_secret: 'secret123',
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        const metadataWithBasicOnly = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/auth',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic']
        };

        const metadataWithPostOnly = {
            ...metadataWithBasicOnly,
            token_endpoint_auth_methods_supported: ['client_secret_post']
        };

        const metadataWithNoneOnly = {
            ...metadataWithBasicOnly,
            token_endpoint_auth_methods_supported: ['none']
        };

        const metadataWithAllBuiltinMethods = {
            ...metadataWithBasicOnly,
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none']
        };

        it('uses HTTP Basic authentication when client_secret_basic is supported', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                metadata: metadataWithBasicOnly,
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                redirectUri: 'http://localhost:3000/callback',
                codeVerifier: 'verifier123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // Check Authorization header
            const authHeader = request.headers.get('Authorization');
            const expected = 'Basic ' + btoa('client123:secret123');
            expect(authHeader).toBe(expected);

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
        });

        it('includes credentials in request body when client_secret_post is supported', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                metadata: metadataWithPostOnly,
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                redirectUri: 'http://localhost:3000/callback',
                codeVerifier: 'verifier123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // Check no Authorization header
            expect(request.headers.get('Authorization')).toBeNull();

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
        });

        it('it picks client_secret_basic when all builtin methods are supported', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                metadata: metadataWithAllBuiltinMethods,
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                redirectUri: 'http://localhost:3000/callback',
                codeVerifier: 'verifier123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // Check Authorization header - should use Basic auth as it's the most secure
            const authHeader = request.headers.get('Authorization');
            const expected = 'Basic ' + btoa('client123:secret123');
            expect(authHeader).toBe(expected);

            // Credentials should not be in body when using Basic auth
            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
        });

        it('uses public client authentication when none method is specified', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const clientInfoWithoutSecret = {
                client_id: 'client123',
                redirect_uris: ['http://localhost:3000/callback'],
                client_name: 'Test Client'
            };

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                metadata: metadataWithNoneOnly,
                clientInformation: clientInfoWithoutSecret,
                authorizationCode: 'code123',
                redirectUri: 'http://localhost:3000/callback',
                codeVerifier: 'verifier123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // Check no Authorization header
            expect(request.headers.get('Authorization')).toBeNull();

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBeNull();
        });

        it('defaults to client_secret_basic when no auth methods specified (RFC 8414 §2)', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await exchangeAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                redirectUri: 'http://localhost:3000/callback',
                codeVerifier: 'verifier123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // RFC 8414 §2: when token_endpoint_auth_methods_supported is omitted,
            // the default is client_secret_basic (HTTP Basic auth, not body params)
            const authHeader = request.headers.get('Authorization');
            const expected = 'Basic ' + btoa('client123:secret123');
            expect(authHeader).toBe(expected);

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBeNull();
            expect(body.get('client_secret')).toBeNull();
        });
    });

    describe('refreshAuthorization with multiple client authentication methods', () => {
        const validTokens = {
            access_token: 'newaccess123',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'newrefresh123'
        };

        const validClientInfo = {
            client_id: 'client123',
            client_secret: 'secret123',
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        const metadataWithBasicOnly = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/auth',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
            token_endpoint_auth_methods_supported: ['client_secret_basic']
        };

        const metadataWithPostOnly = {
            ...metadataWithBasicOnly,
            token_endpoint_auth_methods_supported: ['client_secret_post']
        };

        it('uses client_secret_basic for refresh token', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await refreshAuthorization('https://auth.example.com', {
                metadata: metadataWithBasicOnly,
                clientInformation: validClientInfo,
                refreshToken: 'refresh123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // Check Authorization header
            const authHeader = request.headers.get('Authorization');
            const expected = 'Basic ' + btoa('client123:secret123');
            expect(authHeader).toBe(expected);

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBeNull(); // should not be in body
            expect(body.get('client_secret')).toBeNull(); // should not be in body
            expect(body.get('refresh_token')).toBe('refresh123');
        });

        it('uses client_secret_post for refresh token', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validTokens
            });

            const tokens = await refreshAuthorization('https://auth.example.com', {
                metadata: metadataWithPostOnly,
                clientInformation: validClientInfo,
                refreshToken: 'refresh123'
            });

            expect(tokens).toEqual(validTokens);
            const request = mockFetch.mock.calls[0]![1];

            // Check no Authorization header
            expect(request.headers.get('Authorization')).toBeNull();

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
            expect(body.get('refresh_token')).toBe('refresh123');
        });
    });

    describe('RequestInit headers passthrough', () => {
        it('custom headers from RequestInit are passed to auth discovery requests', async () => {
            const { createFetchWithInit } = await import('@modelcontextprotocol/core-internal');

            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    resource: 'https://resource.example.com',
                    authorization_servers: ['https://auth.example.com']
                })
            });

            // Create a wrapped fetch with custom headers
            const wrappedFetch = createFetchWithInit(customFetch, {
                headers: {
                    'user-agent': 'MyApp/1.0',
                    'x-custom-header': 'test-value'
                }
            });

            await discoverOAuthProtectedResourceMetadata('https://resource.example.com', undefined, wrappedFetch);

            expect(customFetch).toHaveBeenCalledTimes(1);
            const [url, options] = customFetch.mock.calls[0]!;

            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
            expect(options.headers).toMatchObject({
                'user-agent': 'MyApp/1.0',
                'x-custom-header': 'test-value',
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('auth-specific headers override base headers from RequestInit', async () => {
            const { createFetchWithInit } = await import('@modelcontextprotocol/core-internal');

            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://auth.example.com',
                    authorization_endpoint: 'https://auth.example.com/authorize',
                    token_endpoint: 'https://auth.example.com/token',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                })
            });

            // Create a wrapped fetch with a custom Accept header
            const wrappedFetch = createFetchWithInit(customFetch, {
                headers: {
                    Accept: 'text/plain',
                    'user-agent': 'MyApp/1.0'
                }
            });

            await discoverAuthorizationServerMetadata('https://auth.example.com', {
                fetchFn: wrappedFetch
            });

            expect(customFetch).toHaveBeenCalled();
            const [, options] = customFetch.mock.calls[0]!;

            // Auth-specific Accept header should override base Accept header
            expect(options.headers).toMatchObject({
                Accept: 'application/json', // Auth-specific value wins
                'user-agent': 'MyApp/1.0', // Base value preserved
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('other RequestInit options are passed through', async () => {
            const { createFetchWithInit } = await import('@modelcontextprotocol/core-internal');

            const customFetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({
                    resource: 'https://resource.example.com',
                    authorization_servers: ['https://auth.example.com']
                })
            });

            // Create a wrapped fetch with various RequestInit options
            const wrappedFetch = createFetchWithInit(customFetch, {
                credentials: 'include',
                mode: 'cors',
                cache: 'no-cache',
                headers: {
                    'user-agent': 'MyApp/1.0'
                }
            });

            await discoverOAuthProtectedResourceMetadata('https://resource.example.com', undefined, wrappedFetch);

            expect(customFetch).toHaveBeenCalledTimes(1);
            const [, options] = customFetch.mock.calls[0]!;

            // All RequestInit options should be preserved
            expect(options.credentials).toBe('include');
            expect(options.mode).toBe('cors');
            expect(options.cache).toBe('no-cache');
            expect(options.headers).toMatchObject({
                'user-agent': 'MyApp/1.0'
            });
        });
    });

    describe('isHttpsUrl', () => {
        it('returns true for valid HTTPS URL with path', () => {
            expect(isHttpsUrl('https://example.com/client-metadata.json')).toBe(true);
        });

        it('returns true for HTTPS URL with query params', () => {
            expect(isHttpsUrl('https://example.com/metadata?version=1')).toBe(true);
        });

        it('returns false for HTTPS URL without path', () => {
            expect(isHttpsUrl('https://example.com')).toBe(false);
            expect(isHttpsUrl('https://example.com/')).toBe(false);
        });

        it('returns false for HTTP URL', () => {
            expect(isHttpsUrl('http://example.com/metadata')).toBe(false);
        });

        it('returns false for non-URL strings', () => {
            expect(isHttpsUrl('not a url')).toBe(false);
        });

        it('returns false for undefined', () => {
            expect(isHttpsUrl(undefined)).toBe(false);
        });

        it('returns false for empty string', () => {
            expect(isHttpsUrl('')).toBe(false);
        });

        it('returns false for javascript: scheme', () => {
            expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
        });

        it('returns false for data: scheme', () => {
            expect(isHttpsUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        });
    });

    describe('SEP-991: URL-based Client ID fallback logic', () => {
        const validClientMetadata = {
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client',
            client_uri: 'https://example.com/client-metadata.json'
        };

        const mockProvider: OAuthClientProvider = {
            get redirectUrl() {
                return 'http://localhost:3000/callback';
            },
            clientMetadataUrl: 'https://example.com/client-metadata.json',
            get clientMetadata() {
                return validClientMetadata;
            },
            clientInformation: vi.fn().mockResolvedValue(undefined),
            saveClientInformation: vi.fn().mockResolvedValue(undefined),
            tokens: vi.fn().mockResolvedValue(undefined),
            saveTokens: vi.fn().mockResolvedValue(undefined),
            redirectToAuthorization: vi.fn().mockResolvedValue(undefined),
            saveCodeVerifier: vi.fn().mockResolvedValue(undefined),
            codeVerifier: vi.fn().mockResolvedValue('verifier123')
        };

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('uses URL-based client ID when server supports it', async () => {
            // Mock protected resource metadata discovery (404 to skip)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            // Mock authorization server metadata discovery to return support for URL-based client IDs
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://server.example.com',
                    authorization_endpoint: 'https://server.example.com/authorize',
                    token_endpoint: 'https://server.example.com/token',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256'],
                    client_id_metadata_document_supported: true // SEP-991 support
                })
            });

            await auth(mockProvider, {
                serverUrl: 'https://server.example.com'
            });

            // Should save URL-based client info (stamped with the resolved issuer + ctx)
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith(
                { client_id: 'https://example.com/client-metadata.json', issuer: 'https://server.example.com' },
                { issuer: 'https://server.example.com' }
            );
        });

        it('falls back to DCR when server does not support URL-based client IDs', async () => {
            // Mock protected resource metadata discovery (404 to skip)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            // Mock authorization server metadata discovery without SEP-991 support
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://server.example.com',
                    authorization_endpoint: 'https://server.example.com/authorize',
                    token_endpoint: 'https://server.example.com/token',
                    registration_endpoint: 'https://server.example.com/register',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256']
                    // No client_id_metadata_document_supported
                })
            });

            // Mock DCR response
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({
                    client_id: 'generated-uuid',
                    client_secret: 'generated-secret',
                    redirect_uris: ['http://localhost:3000/callback']
                })
            });

            await auth(mockProvider, {
                serverUrl: 'https://server.example.com'
            });

            // Should save DCR client info
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith(
                {
                    client_id: 'generated-uuid',
                    client_secret: 'generated-secret',
                    redirect_uris: ['http://localhost:3000/callback'],
                    issuer: 'https://server.example.com'
                },
                { issuer: 'https://server.example.com' }
            );
        });

        it('throws an error when clientMetadataUrl is not an HTTPS URL', async () => {
            const providerWithInvalidUri = {
                ...mockProvider,
                clientMetadataUrl: 'http://example.com/metadata'
            };

            // Mock protected resource metadata discovery (404 to skip)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            // Mock authorization server metadata discovery with SEP-991 support
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://server.example.com',
                    authorization_endpoint: 'https://server.example.com/authorize',
                    token_endpoint: 'https://server.example.com/token',
                    registration_endpoint: 'https://server.example.com/register',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256'],
                    client_id_metadata_document_supported: true
                })
            });

            await expect(
                auth(providerWithInvalidUri, {
                    serverUrl: 'https://server.example.com'
                })
            ).rejects.toMatchObject({ code: OAuthErrorCode.InvalidClientMetadata });
        });

        it('throws an error when clientMetadataUrl has root pathname', async () => {
            const providerWithRootPathname = {
                ...mockProvider,
                clientMetadataUrl: 'https://example.com/'
            };

            // Mock protected resource metadata discovery (404 to skip)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            // Mock authorization server metadata discovery with SEP-991 support
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://server.example.com',
                    authorization_endpoint: 'https://server.example.com/authorize',
                    token_endpoint: 'https://server.example.com/token',
                    registration_endpoint: 'https://server.example.com/register',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256'],
                    client_id_metadata_document_supported: true
                })
            });

            await expect(
                auth(providerWithRootPathname, {
                    serverUrl: 'https://server.example.com'
                })
            ).rejects.toMatchObject({ code: OAuthErrorCode.InvalidClientMetadata });
        });

        it('throws an error when clientMetadataUrl is not a valid URL', async () => {
            const providerWithInvalidUrl = {
                ...mockProvider,
                clientMetadataUrl: 'not-a-valid-url'
            };

            // Mock protected resource metadata discovery (404 to skip)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            // Mock authorization server metadata discovery with SEP-991 support
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://server.example.com',
                    authorization_endpoint: 'https://server.example.com/authorize',
                    token_endpoint: 'https://server.example.com/token',
                    registration_endpoint: 'https://server.example.com/register',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256'],
                    client_id_metadata_document_supported: true
                })
            });

            await expect(
                auth(providerWithInvalidUrl, {
                    serverUrl: 'https://server.example.com'
                })
            ).rejects.toMatchObject({ code: OAuthErrorCode.InvalidClientMetadata });
        });

        it('falls back to DCR when client_uri is missing', async () => {
            const providerWithoutUri = {
                ...mockProvider,
                clientMetadataUrl: undefined
            };

            // Mock protected resource metadata discovery (404 to skip)
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            // Mock authorization server metadata discovery with SEP-991 support
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    issuer: 'https://server.example.com',
                    authorization_endpoint: 'https://server.example.com/authorize',
                    token_endpoint: 'https://server.example.com/token',
                    registration_endpoint: 'https://server.example.com/register',
                    response_types_supported: ['code'],
                    code_challenge_methods_supported: ['S256'],
                    client_id_metadata_document_supported: true
                })
            });

            // Mock DCR response
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({
                    client_id: 'generated-uuid',
                    client_secret: 'generated-secret',
                    redirect_uris: ['http://localhost:3000/callback']
                })
            });

            await auth(providerWithoutUri, {
                serverUrl: 'https://server.example.com'
            });

            // Should fall back to DCR
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith(
                {
                    client_id: 'generated-uuid',
                    client_secret: 'generated-secret',
                    redirect_uris: ['http://localhost:3000/callback'],
                    issuer: 'https://server.example.com'
                },
                { issuer: 'https://server.example.com' }
            );
        });
    });

    describe('validateClientMetadataUrl', () => {
        it('passes for valid HTTPS URL with path', () => {
            expect(() => validateClientMetadataUrl('https://client.example.com/.well-known/oauth-client')).not.toThrow();
        });

        it('passes for valid HTTPS URL with multi-segment path', () => {
            expect(() => validateClientMetadataUrl('https://example.com/clients/metadata.json')).not.toThrow();
        });

        it('throws OAuthError for HTTP URL', () => {
            expect(() => validateClientMetadataUrl('http://client.example.com/.well-known/oauth-client')).toThrow(OAuthError);
            try {
                validateClientMetadataUrl('http://client.example.com/.well-known/oauth-client');
            } catch (error) {
                expect(error).toBeInstanceOf(OAuthError);
                expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidClientMetadata);
                expect((error as OAuthError).message).toContain('http://client.example.com/.well-known/oauth-client');
            }
        });

        it('throws OAuthError for non-URL string', () => {
            expect(() => validateClientMetadataUrl('not-a-url')).toThrow(OAuthError);
            try {
                validateClientMetadataUrl('not-a-url');
            } catch (error) {
                expect(error).toBeInstanceOf(OAuthError);
                expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidClientMetadata);
                expect((error as OAuthError).message).toContain('not-a-url');
            }
        });

        it('passes silently for empty string', () => {
            expect(() => validateClientMetadataUrl('')).not.toThrow();
        });

        it('throws OAuthError for root-path HTTPS URL with trailing slash', () => {
            expect(() => validateClientMetadataUrl('https://client.example.com/')).toThrow(OAuthError);
            try {
                validateClientMetadataUrl('https://client.example.com/');
            } catch (error) {
                expect(error).toBeInstanceOf(OAuthError);
                expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidClientMetadata);
                expect((error as OAuthError).message).toContain('https://client.example.com/');
            }
        });

        it('throws OAuthError for root-path HTTPS URL without trailing slash', () => {
            expect(() => validateClientMetadataUrl('https://client.example.com')).toThrow(OAuthError);
            try {
                validateClientMetadataUrl('https://client.example.com');
            } catch (error) {
                expect(error).toBeInstanceOf(OAuthError);
                expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidClientMetadata);
                expect((error as OAuthError).message).toContain('https://client.example.com');
            }
        });

        it('passes silently for undefined', () => {
            expect(() => validateClientMetadataUrl(undefined)).not.toThrow();
        });

        it('error message matches expected format', () => {
            expect(() => validateClientMetadataUrl('http://example.com/path')).toThrow(OAuthError);
            try {
                validateClientMetadataUrl('http://example.com/path');
            } catch (error) {
                expect(error).toBeInstanceOf(OAuthError);
                expect((error as OAuthError).message).toBe(
                    'clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: http://example.com/path'
                );
            }
        });
    });

    describe('resolveClientMetadata', () => {
        const resolve = (clientMetadata: OAuthClientMetadata) =>
            resolveClientMetadata({ clientMetadata, redirectUrl: 'http://localhost:3000/callback' });

        describe('SEP-837: application_type heuristic default', () => {
            it.each([
                ['http://localhost:3000/callback', 'native'],
                ['http://127.0.0.1:8080/cb', 'native'],
                ['http://[::1]:8080/cb', 'native'],
                ['myapp://oauth/callback', 'native'],
                ['com.example.app:/cb', 'native'],
                ['https://app.example.com/callback', 'web'],
                ['http://app.internal/callback', 'web']
            ])('derives application_type for redirect_uri %s → %s', (redirectUri, expected) => {
                expect(resolve({ client_name: 't', redirect_uris: [redirectUri] }).application_type).toBe(expected);
            });

            it("derives 'native' when any one redirect_uri is loopback", () => {
                const md = resolve({ client_name: 't', redirect_uris: ['https://app.example.com/cb', 'http://localhost:3000/cb'] });
                expect(md.application_type).toBe('native');
            });

            it('never overwrites a consumer-set application_type', () => {
                const md = resolve({
                    client_name: 't',
                    redirect_uris: ['http://localhost:3000/callback'],
                    application_type: 'web'
                });
                // Loopback would heuristically pick 'native'; the consumer's 'web' wins.
                expect(md.application_type).toBe('web');
            });

            it("defaults to 'web' when redirect_uris is empty / undefined", () => {
                expect(resolve({ client_name: 't', redirect_uris: [] }).application_type).toBe('web');
            });
        });

        describe('SEP-2207: grant_types default', () => {
            it("defaults grant_types to ['authorization_code', 'refresh_token'] when omitted", () => {
                const md = resolve({ client_name: 't', redirect_uris: ['http://localhost:3000/callback'] });
                expect(md.grant_types).toEqual(['authorization_code', 'refresh_token']);
            });

            it('never overwrites a consumer-set grant_types', () => {
                const md = resolve({
                    client_name: 't',
                    redirect_uris: ['http://localhost:3000/callback'],
                    grant_types: ['client_credentials']
                });
                expect(md.grant_types).toEqual(['client_credentials']);
            });

            it('leaves grant_types undefined for non-interactive providers (no redirectUrl)', () => {
                const md = resolveClientMetadata({
                    clientMetadata: { client_name: 't', redirect_uris: [] },
                    redirectUrl: undefined
                });
                expect(md.grant_types).toBeUndefined();
            });
        });

        it('preserves all other consumer-set fields verbatim', () => {
            const md = resolve({
                client_name: 'Test Client',
                redirect_uris: ['http://localhost:3000/callback'],
                scope: 'a b c',
                token_endpoint_auth_method: 'none'
            });
            expect(md.client_name).toBe('Test Client');
            expect(md.scope).toBe('a b c');
            expect(md.token_endpoint_auth_method).toBe('none');
        });
    });

    describe('determineScope', () => {
        const baseClientMetadata = {
            redirect_uris: ['http://localhost:3000/callback'],
            client_name: 'Test Client'
        };

        describe('MCP Scope Selection Strategy', () => {
            it('returns explicit requestedScope as-is (priority 1)', () => {
                const result = determineScope({
                    requestedScope: 'files:read',
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    clientMetadata: {
                        ...baseClientMetadata,
                        scope: 'fallback:scope'
                    }
                });

                expect(result).toBe('files:read');
            });

            it('uses PRM scopes_supported when no explicit scope (priority 2)', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin']
                    },
                    clientMetadata: {
                        ...baseClientMetadata,
                        scope: 'fallback:scope'
                    }
                });

                expect(result).toBe('mcp:read mcp:write mcp:admin');
            });

            it('falls back to clientMetadata.scope when no PRM scopes (priority 3)', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/'
                    },
                    clientMetadata: {
                        ...baseClientMetadata,
                        scope: 'client:default'
                    }
                });

                expect(result).toBe('client:default');
            });

            it('returns undefined when no scope source available (priority 4)', () => {
                const result = determineScope({
                    clientMetadata: baseClientMetadata
                });

                expect(result).toBeUndefined();
            });

            it('returns undefined when PRM has no scopes_supported and clientMetadata has no scope', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/'
                    },
                    clientMetadata: baseClientMetadata
                });

                expect(result).toBeUndefined();
            });
        });

        describe('SEP-2207: offline_access scope augmentation', () => {
            const asMetadataWithOfflineAccess = {
                issuer: 'https://auth.example.com',
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
                response_types_supported: ['code'] as string[],
                scopes_supported: ['openid', 'profile', 'offline_access']
            };

            const asMetadataWithoutOfflineAccess = {
                issuer: 'https://auth.example.com',
                authorization_endpoint: 'https://auth.example.com/authorize',
                token_endpoint: 'https://auth.example.com/token',
                response_types_supported: ['code'] as string[],
                scopes_supported: ['openid', 'profile']
            };

            const clientMetadataWithRefreshToken = {
                ...baseClientMetadata,
                grant_types: ['authorization_code', 'refresh_token']
            };

            it('augments explicit scope with offline_access', () => {
                const result = determineScope({
                    requestedScope: 'mcp:read mcp:write',
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: clientMetadataWithRefreshToken
                });

                expect(result).toBe('mcp:read mcp:write offline_access');
            });

            it('adds offline_access when AS supports it and client grant_types includes refresh_token', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: clientMetadataWithRefreshToken
                });

                expect(result).toBe('mcp:read mcp:write offline_access');
            });

            it('adds offline_access when using clientMetadata.scope fallback', () => {
                const result = determineScope({
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: {
                        ...clientMetadataWithRefreshToken,
                        scope: 'mcp:tools'
                    }
                });

                expect(result).toBe('mcp:tools offline_access');
            });

            it('does NOT augment when no other scopes are present', () => {
                const result = determineScope({
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: clientMetadataWithRefreshToken
                });

                expect(result).toBeUndefined();
            });

            it('does NOT augment when AS metadata lacks offline_access', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    authServerMetadata: asMetadataWithoutOfflineAccess,
                    clientMetadata: clientMetadataWithRefreshToken
                });

                expect(result).toBe('mcp:read mcp:write');
            });

            it('does NOT augment when AS metadata is undefined', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    clientMetadata: clientMetadataWithRefreshToken
                });

                expect(result).toBe('mcp:read mcp:write');
            });

            it('does NOT augment when offline_access already in clientMetadata.scope', () => {
                const result = determineScope({
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: {
                        ...clientMetadataWithRefreshToken,
                        scope: 'mcp:tools offline_access'
                    }
                });

                expect(result).toBe('mcp:tools offline_access');
            });

            it('does NOT augment when non-compliant PRM already includes offline_access', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'offline_access', 'mcp:write']
                    },
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: clientMetadataWithRefreshToken
                });

                expect(result).toBe('mcp:read offline_access mcp:write');
            });

            it('does NOT augment when grant_types omits refresh_token', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: {
                        ...baseClientMetadata,
                        grant_types: ['authorization_code']
                    }
                });

                expect(result).toBe('mcp:read mcp:write');
            });

            it('does NOT augment with offline_access when grant_types is undefined (respects OAuth defaults)', () => {
                const result = determineScope({
                    resourceMetadata: {
                        resource: 'https://api.example.com/',
                        scopes_supported: ['mcp:read', 'mcp:write']
                    },
                    authServerMetadata: asMetadataWithOfflineAccess,
                    clientMetadata: baseClientMetadata
                });

                expect(result).toBe('mcp:read mcp:write');
            });

            it('auth() does not push statically-registered clients into offline_access + prompt=consent', async () => {
                mockFetch.mockImplementation(url => {
                    const urlString = url.toString();
                    if (urlString.includes('/.well-known/oauth-protected-resource')) {
                        return Promise.resolve({ ok: false, status: 404 });
                    }
                    if (urlString.includes('/.well-known/oauth-authorization-server')) {
                        return Promise.resolve({
                            ok: true,
                            status: 200,
                            json: async () => ({
                                issuer: 'https://api.example.com',
                                authorization_endpoint: 'https://api.example.com/authorize',
                                token_endpoint: 'https://api.example.com/token',
                                response_types_supported: ['code'],
                                scopes_supported: ['mcp:read', 'offline_access']
                            })
                        });
                    }
                    return Promise.resolve({ ok: false, status: 404 });
                });
                const redirectToAuthorization = vi.fn();
                const provider: OAuthClientProvider = {
                    get redirectUrl() {
                        return 'http://localhost:3000/callback';
                    },
                    get clientMetadata() {
                        return { redirect_uris: ['http://localhost:3000/callback'], scope: 'mcp:read' };
                    },
                    clientInformation: () => ({ client_id: 'static' }),
                    tokens: () => undefined,
                    saveTokens: vi.fn(),
                    redirectToAuthorization,
                    saveCodeVerifier: vi.fn(),
                    codeVerifier: () => 'v'
                };

                const result = await auth(provider, { serverUrl: 'https://api.example.com/mcp' });
                expect(result).toBe('REDIRECT');
                const authorizationUrl = redirectToAuthorization.mock.calls[0]![0] as URL;
                expect(authorizationUrl.searchParams.get('scope')).toBe('mcp:read');
                expect(authorizationUrl.searchParams.has('prompt')).toBe(false);
            });
        });
    });

    describe('SEP-2352: per-authorization-server credential isolation (issuer-stamped)', () => {
        const AS_ONE = 'https://as-one.example.com';
        const AS_TWO = 'https://as-two.example.com';

        const asMetadata = (issuer: string): AuthorizationServerMetadata => ({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials']
        });

        function createMigratingFetch() {
            let active = AS_ONE;
            const registerCalls: string[] = [];
            const tokenCalls: Array<{ issuer: string; body: URLSearchParams }> = [];
            const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
                const u = new URL(String(url));
                if (u.pathname.includes('/.well-known/oauth-protected-resource')) {
                    return Response.json({ resource: 'https://api.example.com/mcp', authorization_servers: [active] });
                }
                if (u.pathname.includes('/.well-known/')) {
                    return Response.json(asMetadata(u.origin));
                }
                if (u.pathname === '/register') {
                    registerCalls.push(u.origin);
                    return Response.json({ client_id: `cid-${u.host}`, client_secret: 's', redirect_uris: [] }, { status: 201 });
                }
                if (u.pathname === '/token') {
                    const body = new URLSearchParams(String(init?.body));
                    tokenCalls.push({ issuer: u.origin, body });
                    return Response.json({ access_token: 'at', token_type: 'Bearer' });
                }
                return new Response(null, { status: 404 });
            };
            return { fetchFn, registerCalls, tokenCalls, switchTo: (i: string) => (active = i) };
        }

        /** Single-slot blob provider — round-trips the SDK-stamped values verbatim. */
        function createBlobProvider(withDiscoveryState = true): OAuthClientProvider & {
            redirected: URL[];
            stored: { info?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens };
        } {
            const stored: { info?: StoredOAuthClientInformation; tokens?: StoredOAuthTokens } = {};
            const redirected: URL[] = [];
            let discovery: OAuthDiscoveryState | undefined;
            let verifier: string | undefined;
            return {
                redirected,
                stored,
                get redirectUrl() {
                    return 'http://localhost:3000/callback';
                },
                get clientMetadata() {
                    return { client_name: 't', redirect_uris: ['http://localhost:3000/callback'] };
                },
                clientInformation: () => stored.info,
                saveClientInformation: i => void (stored.info = i),
                tokens: () => stored.tokens,
                saveTokens: t => void (stored.tokens = t),
                redirectToAuthorization: u => void redirected.push(u),
                saveCodeVerifier: v => void (verifier = v),
                codeVerifier: () => verifier ?? 'v',
                ...(withDiscoveryState && {
                    saveDiscoveryState: (s: OAuthDiscoveryState) => void (discovery = s),
                    discoveryState: () => discovery,
                    invalidateCredentials: (s: string) => {
                        if (s === 'client' || s === 'all') stored.info = undefined;
                        if (s === 'tokens' || s === 'all') stored.tokens = undefined;
                        if (s === 'discovery' || s === 'all') discovery = undefined;
                    }
                })
            };
        }

        it('discardIfIssuerMismatch: returns undefined only on a different stamp; warns on unstamped', () => {
            const stamped: StoredOAuthTokens = { access_token: 'a', token_type: 'Bearer', issuer: AS_ONE };
            const unstamped: StoredOAuthTokens = { access_token: 'a', token_type: 'Bearer' };
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(discardIfIssuerMismatch(stamped, AS_ONE)).toBe(stamped);
            expect(discardIfIssuerMismatch(stamped, AS_TWO)).toBeUndefined();
            expect(discardIfIssuerMismatch(unstamped, AS_TWO)).toBe(unstamped);
            expect(discardIfIssuerMismatch<StoredOAuthTokens>(undefined, AS_TWO)).toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(1);
            warn.mockRestore();
        });

        it('clientInformation stamped for AS-one is discarded at AS-two → re-registers (single-slot blob provider)', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();

            expect(await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(provider.stored.info?.issuer).toBe(AS_ONE);
            expect(srv.registerCalls).toEqual([AS_ONE]);

            srv.switchTo(AS_TWO);
            provider.invalidateCredentials?.('discovery');
            expect(await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(srv.registerCalls).toEqual([AS_ONE, AS_TWO]);
            expect(provider.stored.info?.issuer).toBe(AS_TWO);
            expect(provider.redirected.at(-1)?.origin).toBe(AS_TWO);
            expect(provider.redirected.at(-1)?.searchParams.get('client_id')).toBe('cid-as-two.example.com');
        });

        it('refresh_token stamped for AS-one is never POSTed to AS-two', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', issuer: AS_TWO };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-one', issuer: AS_ONE };
            srv.switchTo(AS_TWO);

            expect(await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn })).toBe('REDIRECT');
            for (const { issuer, body } of srv.tokenCalls) {
                expect(issuer).not.toBe(AS_TWO);
                expect(body.get('refresh_token')).not.toBe('rt-one');
            }
        });

        it('issuer-keyed provider holds independent credentials per AS', async () => {
            const srv = createMigratingFetch();
            const map = new Map<string, OAuthClientInformationMixed>();
            const provider: OAuthClientProvider = {
                get redirectUrl() {
                    return 'http://localhost:3000/callback';
                },
                get clientMetadata() {
                    return { client_name: 't', redirect_uris: ['http://localhost:3000/callback'] };
                },
                clientInformation: (ctx?: OAuthClientInformationContext) => (ctx ? map.get(ctx.issuer) : undefined),
                saveClientInformation: (i, ctx) => void (ctx && map.set(ctx.issuer, i)),
                tokens: () => undefined,
                saveTokens: () => {},
                redirectToAuthorization: () => {},
                saveCodeVerifier: () => {},
                codeVerifier: () => 'v'
            };

            await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn });
            srv.switchTo(AS_TWO);
            await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn });
            expect(map.get(AS_ONE)?.client_id).toBe('cid-as-one.example.com');
            expect(map.get(AS_TWO)?.client_id).toBe('cid-as-two.example.com');
        });

        it('callback-leg gate throws when discoveryState issuer differs from resolved issuer', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };
            // Recorded redirect target = AS-one, but cached state lacks an authorizationServerUrl
            // so authInternal runs fresh discovery → AS-two.
            provider.saveDiscoveryState?.({
                authorizationServerUrl: '',
                authorizationServerMetadata: asMetadata(AS_ONE)
            } as OAuthDiscoveryState);
            srv.switchTo(AS_TWO);

            await expect(
                auth(provider, { serverUrl: 'https://api.example.com/mcp', authorizationCode: 'code', fetchFn: srv.fetchFn })
            ).rejects.toBeInstanceOf(AuthorizationServerMismatchError);
        });

        it('callback-leg gate fails closed when provider implements saveDiscoveryState but discoveryState() is undefined', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };
            // Provider implements saveDiscoveryState/discoveryState, but the recorded state was
            // lost (e.g. fresh process / page navigation between redirect and callback). The
            // gate must fail closed rather than silently re-discover.
            // (createBlobProvider starts with discoveryState() → undefined.)
            const err = await auth(provider, {
                serverUrl: 'https://api.example.com/mcp',
                authorizationCode: 'code',
                fetchFn: srv.fetchFn
            }).then(
                () => undefined,
                e => e
            );
            expect(err).toBeInstanceOf(AuthorizationServerMismatchError);
            expect((err as AuthorizationServerMismatchError).recordedIssuer).toContain(
                'discoveryState was not available on the callback leg'
            );
            expect(srv.tokenCalls).toHaveLength(0);
        });

        it('warns once on the callback leg when the provider has no discoveryState', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider(false);
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            await auth(provider, {
                serverUrl: 'https://api.example.com/mcp',
                authorizationCode: 'code',
                iss: AS_ONE,
                fetchFn: srv.fetchFn
            });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toContain('saveDiscoveryState');
            warn.mockRestore();
        });

        it('back-stamps a legacy unstamped clientInformation on first use after upgrade', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            // Pre-SEP-2352 storage: no `issuer` field on the stored blob.
            provider.stored.info = { client_id: 'legacy-cid', client_secret: 'legacy-secret' };
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            expect(await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn })).toBe('REDIRECT');
            // First use binds the unstamped value to the resolved AS — closes the permanent window.
            expect(provider.stored.info).toEqual({ client_id: 'legacy-cid', client_secret: 'legacy-secret', issuer: AS_ONE });
            // The legacy value was used, not re-registered.
            expect(srv.registerCalls).toHaveLength(0);
            expect(warn.mock.calls.some(c => String(c[0]).includes("no 'issuer' stamp"))).toBe(true);
            warn.mockRestore();

            // Subsequent call against AS-two now sees a stamped value and re-registers.
            srv.switchTo(AS_TWO);
            provider.invalidateCredentials?.('discovery');
            await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn });
            expect(srv.registerCalls).toEqual([AS_TWO]);
        });

        it('back-stamps a legacy unstamped token set on first use', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-legacy' };
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn });
            // The unstamped token set is written back with the resolved issuer before refresh.
            expect(provider.stored.tokens?.issuer).toBe(AS_ONE);
            warn.mockRestore();
        });

        it('callback-leg gate: saveDiscoveryState is NOT called when AuthorizationServerMismatchError throws', async () => {
            // Case 1: cachedState undefined → fail-closed '(none recorded)' → fresh discovery
            // result must NOT have been persisted (a retry would otherwise read it back as
            // recordedIssuer and the gate would pass).
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            const saveSpy = vi.fn(provider.saveDiscoveryState!);
            provider.saveDiscoveryState = saveSpy;
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };

            await expect(
                auth(provider, { serverUrl: 'https://api.example.com/mcp', authorizationCode: 'code', fetchFn: srv.fetchFn })
            ).rejects.toBeInstanceOf(AuthorizationServerMismatchError);
            expect(saveSpy).not.toHaveBeenCalled();
            expect(provider.discoveryState?.()).toBeUndefined();

            // Case 2: cachedState records AS-one (forces full discovery via empty
            // authorizationServerUrl), discovery resolves AS-two → throw → AS-one record is
            // untouched.
            const srv2 = createMigratingFetch();
            const provider2 = createBlobProvider();
            provider2.stored.info = { client_id: 'cid', issuer: AS_ONE };
            provider2.saveDiscoveryState?.({
                authorizationServerUrl: '',
                authorizationServerMetadata: asMetadata(AS_ONE)
            } as OAuthDiscoveryState);
            srv2.switchTo(AS_TWO);

            await expect(
                auth(provider2, { serverUrl: 'https://api.example.com/mcp', authorizationCode: 'code', fetchFn: srv2.fetchFn })
            ).rejects.toBeInstanceOf(AuthorizationServerMismatchError);
            expect((provider2.discoveryState?.() as OAuthDiscoveryState).authorizationServerMetadata?.issuer).toBe(AS_ONE);
        });

        it('callback-leg gate: trailing-slash difference between recorded fallback URL and metadata issuer is tolerated', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };
            // Redirect leg recorded the SDK-derived String(URL) form (slash-suffixed) with no
            // metadata; callback leg sees metadata.issuer (slash-free). Same AS — must not throw.
            provider.saveDiscoveryState?.({ authorizationServerUrl: AS_ONE + '/' } as OAuthDiscoveryState);

            await expect(
                auth(provider, { serverUrl: 'https://api.example.com/mcp', authorizationCode: 'code', iss: AS_ONE, fetchFn: srv.fetchFn })
            ).resolves.toBe('AUTHORIZED');
        });

        it('discardIfIssuerMismatch: trailing-slash difference does not discard', () => {
            const stamped = { client_id: 'x', issuer: 'https://as.example.com' };
            expect(discardIfIssuerMismatch(stamped, 'https://as.example.com/')).toBe(stamped);
            expect(discardIfIssuerMismatch({ client_id: 'x', issuer: 'https://as.example.com/' }, 'https://as.example.com')).toBeDefined();
        });

        it('invalid_client on code exchange does not surface AuthorizationServerMismatchError', async () => {
            const base = createMigratingFetch();
            const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
                if (new URL(String(url)).pathname === '/token') {
                    return Response.json({ error: 'invalid_client' }, { status: 400 });
                }
                return base.fetchFn(url, init);
            };
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', issuer: AS_ONE };
            provider.saveDiscoveryState?.({
                authorizationServerUrl: AS_ONE,
                authorizationServerMetadata: asMetadata(AS_ONE)
            } as OAuthDiscoveryState);

            const err = await auth(provider, {
                serverUrl: 'https://api.example.com/mcp',
                authorizationCode: 'code',
                iss: AS_ONE,
                fetchFn
            }).then(
                () => undefined,
                e => e
            );
            // The retry surfaces the (comprehensible) missing-client-information error, not a
            // false '(none recorded)' AS-change.
            expect(err).not.toBeInstanceOf(AuthorizationServerMismatchError);
            expect((provider.discoveryState?.() as OAuthDiscoveryState).authorizationServerUrl).toBe(AS_ONE);
        });

        it('ClientCredentialsProvider without expectedIssuer: no SEP-2352 warn on auth()', async () => {
            const srv = createMigratingFetch();
            const provider = new ClientCredentialsProvider({ clientId: 'static', clientSecret: 's' });
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn });
            await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn });
            expect(warn.mock.calls.filter(c => /no 'issuer' stamp/.test(String(c[0])))).toHaveLength(0);
            warn.mockRestore();
        });

        it('m2m expectedIssuer: ClientCredentialsProvider refuses to send the credential to a different AS', async () => {
            const srv = createMigratingFetch();
            srv.switchTo(AS_TWO);
            const provider = new ClientCredentialsProvider({ clientId: 'static', clientSecret: 's', expectedIssuer: AS_ONE });

            const err = await auth(provider, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn }).then(
                () => undefined,
                e => e
            );
            expect(err).toBeInstanceOf(AuthorizationServerMismatchError);
            expect((err as AuthorizationServerMismatchError).recordedIssuer).toBe(AS_ONE);
            expect((err as AuthorizationServerMismatchError).currentIssuer).toBe(AS_TWO);
            expect(srv.tokenCalls.filter(c => c.issuer === AS_TWO)).toHaveLength(0);

            // Matching expectedIssuer proceeds.
            srv.switchTo(AS_ONE);
            const ok = new ClientCredentialsProvider({ clientId: 'static', clientSecret: 's', expectedIssuer: AS_ONE });
            expect(await auth(ok, { serverUrl: 'https://api.example.com/mcp', fetchFn: srv.fetchFn })).toBe('AUTHORIZED');
        });
    });
});
