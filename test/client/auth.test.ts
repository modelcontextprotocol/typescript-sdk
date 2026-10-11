import { LATEST_PROTOCOL_VERSION } from '../../src/types.js';
import {
    discoverOAuthMetadata,
    discoverAuthorizationServerMetadata,
    buildDiscoveryUrls,
    startAuthorization,
    exchangeAuthorization,
    refreshAuthorization,
    registerClient,
    discoverOAuthProtectedResourceMetadata,
    discoverOAuthServerInfo,
    extractWWWAuthenticateParams,
    auth,
    fetchToken,
    type OAuthClientProvider,
    type OAuthDiscoveryState,
    selectClientAuthMethod,
    isHttpsUrl
} from '../../src/client/auth.js';
import { createPrivateKeyJwtAuth } from '../../src/client/auth-extensions.js';
import { InvalidClientMetadataError, ServerError } from '../../src/server/auth/errors.js';
import {
    AuthorizationServerMetadata,
    OAuthClientInformationMixed,
    OAuthClientInformationSchema,
    OAuthClientMetadata,
    OAuthTokens,
    OAuthTokensSchema
} from '../../src/shared/auth.js';
import { expect, vi, type Mock, type MockInstance } from 'vitest';

// Mock pkce-challenge
vi.mock('pkce-challenge', () => ({
    default: () => ({
        code_verifier: 'test_verifier',
        code_challenge: 'test_challenge'
    })
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OAuth Authorization', () => {
    beforeEach(() => {
        mockFetch.mockReset();
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
            const [url] = calls[0];
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
        });

        it('returns metadata when first fetch fails but second without MCP header succeeds', async () => {
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                if (callCount === 1) {
                    // First call with MCP header - fail with TypeError (simulating CORS error)
                    // We need to use TypeError specifically because that's what the implementation checks for
                    return Promise.reject(new TypeError('Network error'));
                } else {
                    // Second call without header - succeed
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validMetadata
                    });
                }
            });

            // Should succeed with the second call
            const metadata = await discoverOAuthProtectedResourceMetadata('https://resource.example.com');
            expect(metadata).toEqual(validMetadata);

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // Verify first call had MCP header
            expect(mockFetch.mock.calls[0][1]?.headers).toHaveProperty('MCP-Protocol-Version');
        });

        it('throws an error when all fetch attempts fail', async () => {
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                if (callCount === 1) {
                    // First call - fail with TypeError
                    return Promise.reject(new TypeError('First failure'));
                } else {
                    // Second call - fail with different error
                    return Promise.reject(new Error('Second failure'));
                }
            });

            // Should fail with the second error
            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com')).rejects.toThrow('Second failure');

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);
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
            const [url] = calls[0];
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
            const [url] = calls[0];
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
                const [firstUrl, firstOptions] = calls[0];
                expect(firstUrl.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource/path/name');
                expect(firstOptions.headers).toEqual({
                    'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
                });

                // Second call should be root fallback
                const [secondUrl, secondOptions] = calls[1];
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

        it('throws error on 500 status and does not fallback', async () => {
            // First call (path-aware) returns 500
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500
            });

            await expect(discoverOAuthProtectedResourceMetadata('https://resource.example.com/path/name')).rejects.toThrow();

            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(1); // Should not attempt fallback
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

            const [url] = calls[0];
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

            const [url] = calls[0];
            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
        });

        it('falls back when path-aware discovery encounters CORS error', async () => {
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
            const [lastUrl, lastOptions] = calls[2];
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

            const [url] = calls[0];
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

            const [url, options] = customFetch.mock.calls[0];
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
            const [url, options] = calls[0];
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
            const [url, options] = calls[0];
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
            const [firstUrl, firstOptions] = calls[0];
            expect(firstUrl.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/path/name');
            expect(firstOptions.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });

            // Second call should be root fallback
            const [secondUrl, secondOptions] = calls[1];
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

            const [url] = calls[0];
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

            const [url] = calls[0];
            expect(url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
        });

        it('falls back when path-aware discovery encounters CORS error', async () => {
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
            const [lastUrl, lastOptions] = calls[2];
            expect(lastUrl.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
            expect(lastOptions.headers).toEqual({
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('returns metadata when first fetch fails but second without MCP header succeeds', async () => {
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                if (callCount === 1) {
                    // First call with MCP header - fail with TypeError (simulating CORS error)
                    // We need to use TypeError specifically because that's what the implementation checks for
                    return Promise.reject(new TypeError('Network error'));
                } else {
                    // Second call without header - succeed
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => validMetadata
                    });
                }
            });

            // Should succeed with the second call
            const metadata = await discoverOAuthMetadata('https://auth.example.com');
            expect(metadata).toEqual(validMetadata);

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);

            // Verify first call had MCP header
            expect(mockFetch.mock.calls[0][1]?.headers).toHaveProperty('MCP-Protocol-Version');
        });

        it('throws an error when all fetch attempts fail', async () => {
            // Set up a counter to control behavior
            let callCount = 0;

            // Mock implementation that changes behavior based on call count
            mockFetch.mockImplementation((_url, _options) => {
                callCount++;

                if (callCount === 1) {
                    // First call - fail with TypeError
                    return Promise.reject(new TypeError('First failure'));
                } else {
                    // Second call - fail with different error
                    return Promise.reject(new Error('Second failure'));
                }
            });

            // Should fail with the second error
            await expect(discoverOAuthMetadata('https://auth.example.com')).rejects.toThrow('Second failure');

            // Verify both calls were made
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('returns undefined when both CORS requests fail in fetchWithCorsRetry', async () => {
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

        it('throws on non-404 errors', async () => {
            mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

            await expect(discoverOAuthMetadata('https://auth.example.com')).rejects.toThrow('HTTP 500');
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

            const [url, options] = customFetch.mock.calls[0];
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
            expect(urls[0].url.toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/tenant1');
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
            // First OAuth URL (path before well-known) fails with 404
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404
            });

            // Second OIDC URL (path before well-known) succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => validOpenIdMetadata
            });

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com/tenant1');

            expect(metadata).toEqual(validOpenIdMetadata);

            // Verify it tried the URLs in the correct order
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);
            expect(calls[0][0].toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/tenant1');
            expect(calls[1][0].toString()).toBe('https://auth.example.com/.well-known/openid-configuration/tenant1');
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

            const metadata = await discoverAuthorizationServerMetadata('https://mcp.example.com');

            expect(metadata).toEqual(validOpenIdMetadata);
        });

        it('throws on non-4xx errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500
            });

            await expect(discoverAuthorizationServerMetadata('https://mcp.example.com')).rejects.toThrow('HTTP 500');
        });

        it('handles CORS errors with retry', async () => {
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
            expect(calls[0][1]?.headers).toHaveProperty('MCP-Protocol-Version');

            // Second call should not have headers (CORS retry)
            expect(calls[1][1]?.headers).toBeUndefined();
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
            const [, options] = calls[0];
            expect(options.headers).toEqual({
                'MCP-Protocol-Version': '2025-01-01',
                Accept: 'application/json'
            });
        });

        it('returns undefined when all URLs fail with CORS errors', async () => {
            // All fetch attempts fail with CORS errors (TypeError)
            mockFetch.mockImplementation(() => Promise.reject(new TypeError('CORS error')));

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com/tenant1');

            expect(metadata).toBeUndefined();

            // Verify that all discovery URLs were attempted
            expect(mockFetch).toHaveBeenCalledTimes(6); // 3 URLs × 2 attempts each (with and without headers)
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

            // Verify the token request includes the resource parameter from cached metadata,
            // preserved verbatim (no trailing slash added — see #1968).
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

        it('preserves a string resource indicator without URL normalization', async () => {
            const { authorizationUrl } = await startAuthorization('https://auth.example.com', {
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

            const options = mockFetch.mock.calls[0][1];
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

            const options = mockFetch.mock.calls[0][1];
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

            const headers = mockFetch.mock.calls[0][1].headers as Headers;
            expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            expect(headers.get('Authorization')).toBe('Basic Y2xpZW50MTIzOnNlY3JldDEyMw==');
            const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
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
            mockFetch.mockResolvedValueOnce(Response.json(new ServerError('Token exchange failed').toResponseObject(), { status: 400 }));

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

            const [url, options] = customFetch.mock.calls[0];
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

            const headers = mockFetch.mock.calls[0][1].headers as Headers;
            expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
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

            const headers = mockFetch.mock.calls[0][1].headers as Headers;
            expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            expect(headers.get('Authorization')).toBe('Basic Y2xpZW50MTIzOnNlY3JldDEyMw==');
            const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
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
            mockFetch.mockResolvedValueOnce(Response.json(new ServerError('Token refresh failed').toResponseObject(), { status: 400 }));

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
            client_id_issued_at: 1612137600,
            client_secret_expires_at: 1612224000,
            ...validClientMetadata
        };

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
                expect.objectContaining({
                    href: 'https://auth.example.com/register'
                }),
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(validClientMetadata)
                })
            );
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
                expect.objectContaining({
                    href: 'https://auth.example.com/register'
                }),
                expect.objectContaining({
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ ...validClientMetadata, scope: 'openid profile' })
                })
            );
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
                Response.json(new ServerError('Dynamic client registration failed').toResponseObject(), { status: 400 })
            );

            await expect(
                registerClient('https://auth.example.com', {
                    clientMetadata: validClientMetadata
                })
            ).rejects.toThrow('Dynamic client registration failed');
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
                            issuer: 'https://auth.example.com',
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
                            client_id_issued_at: 1612137600,
                            client_secret_expires_at: 1612224000,
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
            expect(mockFetch.mock.calls[0][0].toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');

            // Second call should be to oauth metadata at the root path
            expect(mockFetch.mock.calls[1][0].toString()).toBe('https://resource.example.com/.well-known/oauth-authorization-server');
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
                            client_id_issued_at: 1612137600,
                            client_secret_expires_at: 1612224000,
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

            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0];
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

            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0];
            const authUrl: URL = redirectCall[0];
            // Should use the PRM's resource value, not the full requested URL
            expect(authUrl.searchParams.get('resource')).toBe('https://api.example.com/');
        });

        it('sends a pathless PRM resource verbatim on the authorization and token requests (#1968)', async () => {
            // RFC 9728 publishes the resource identifier and RFC 8707 requires it to be
            // sent unchanged. `new URL('https://example.com').href` is 'https://example.com/',
            // and authorization servers that match the indicator exactly (Microsoft Entra
            // ID: AADSTS9010010) reject the extra slash.
            mockFetch.mockImplementation(url => {
                const urlString = url.toString();

                if (urlString.includes('/.well-known/oauth-protected-resource')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        json: async () => ({
                            resource: 'https://example.com',
                            authorization_servers: ['https://auth.example.com'],
                            scopes_supported: ['https://example.com/mcp:tools']
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
                        json: async () => ({ access_token: 'access123', token_type: 'bearer', expires_in: 3600 })
                    });
                }

                return Promise.resolve({ ok: false, status: 404 });
            });

            (mockProvider.clientInformation as Mock).mockResolvedValue({
                client_id: 'test-client',
                client_secret: 'test-secret'
            });
            (mockProvider.tokens as Mock).mockResolvedValue(undefined);
            (mockProvider.saveCodeVerifier as Mock).mockResolvedValue(undefined);
            (mockProvider.redirectToAuthorization as Mock).mockResolvedValue(undefined);
            (mockProvider.codeVerifier as Mock).mockResolvedValue('verifier123');
            (mockProvider.saveTokens as Mock).mockResolvedValue(undefined);

            // Authorization request: the redirect carries the metadata value byte for byte.
            const redirectResult = await auth(mockProvider, { serverUrl: 'https://example.com/mcp' });
            expect(redirectResult).toBe('REDIRECT');
            const authUrl: URL = (mockProvider.redirectToAuthorization as Mock).mock.calls[0][0];
            expect(authUrl.searchParams.get('resource')).toBe('https://example.com');

            // Token request: the authorization-code exchange sends the same value.
            const exchangeResult = await auth(mockProvider, {
                serverUrl: 'https://example.com/mcp',
                authorizationCode: 'code123'
            });
            expect(exchangeResult).toBe('AUTHORIZED');
            const tokenCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/token'));
            expect(tokenCall).toBeDefined();
            const body = tokenCall![1].body as URLSearchParams;
            expect(body.get('resource')).toBe('https://example.com');
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

            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0];
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
            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0];
            const authUrl: URL = redirectCall[0];
            expect(authUrl.searchParams.get('scope')).toBe('mcp:read mcp:write mcp:admin');

            // Verify the same scope was also used in the DCR request body
            const registerCall = mockFetch.mock.calls.find(call => call[0].toString().includes('/register'));
            expect(registerCall).toBeDefined();
            const registerBody = JSON.parse(registerCall![1].body);
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
            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0];
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
            expect(calls[0][0].toString()).toBe('https://my.resource.com/.well-known/oauth-protected-resource/path/name');

            // Second call should be to AS metadata with the path from authorization server
            expect(calls[1][0].toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server/oauth');
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
            expect(customFetch.mock.calls[0][0].toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');

            // Verify custom fetch was called for AS metadata discovery
            expect(customFetch.mock.calls[1][0].toString()).toBe('https://auth.example.com/.well-known/oauth-authorization-server');
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
            const request = mockFetch.mock.calls[0][1];

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
            const request = mockFetch.mock.calls[0][1];

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
            const request = mockFetch.mock.calls[0][1];

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
            const request = mockFetch.mock.calls[0][1];

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
            const request = mockFetch.mock.calls[0][1];

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
            const request = mockFetch.mock.calls[0][1];

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
            const request = mockFetch.mock.calls[0][1];

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
            const { createFetchWithInit } = await import('../../src/shared/transport.js');

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
            const [url, options] = customFetch.mock.calls[0];

            expect(url.toString()).toBe('https://resource.example.com/.well-known/oauth-protected-resource');
            expect(options.headers).toMatchObject({
                'user-agent': 'MyApp/1.0',
                'x-custom-header': 'test-value',
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('auth-specific headers override base headers from RequestInit', async () => {
            const { createFetchWithInit } = await import('../../src/shared/transport.js');

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
            const [, options] = customFetch.mock.calls[0];

            // Auth-specific Accept header should override base Accept header
            expect(options.headers).toMatchObject({
                Accept: 'application/json', // Auth-specific value wins
                'user-agent': 'MyApp/1.0', // Base value preserved
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION
            });
        });

        it('other RequestInit options are passed through', async () => {
            const { createFetchWithInit } = await import('../../src/shared/transport.js');

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
            const [, options] = customFetch.mock.calls[0];

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

            // Should save URL-based client info
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith({
                client_id: 'https://example.com/client-metadata.json',
                issuer: 'https://server.example.com/'
            });
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
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith({
                client_id: 'generated-uuid',
                client_secret: 'generated-secret',
                redirect_uris: ['http://localhost:3000/callback'],
                issuer: 'https://server.example.com/'
            });
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
            ).rejects.toThrow(InvalidClientMetadataError);
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
            ).rejects.toThrow(InvalidClientMetadataError);
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
            ).rejects.toThrow(InvalidClientMetadataError);
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
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith({
                client_id: 'generated-uuid',
                client_secret: 'generated-secret',
                redirect_uris: ['http://localhost:3000/callback'],
                issuer: 'https://server.example.com/'
            });
        });
    });
    describe('auth: credentials are bound to the authorization server that issued them', () => {
        const SERVER_URL = 'https://api.example.com/mcp';
        const AS_ONE = 'https://as-one.example.com';
        const AS_TWO = 'https://as-two.example.com';

        const asMetadata = (issuer: string, endpoints = issuer): AuthorizationServerMetadata => ({
            issuer,
            authorization_endpoint: `${endpoints}/authorize`,
            token_endpoint: `${endpoints}/token`,
            registration_endpoint: `${endpoints}/register`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials']
        });

        /**
         * Resource server whose protected resource metadata advertises `active` as the authorization
         * server; every origin answers authorization server metadata for itself. Records where
         * registrations and token requests were sent.
         */
        function createMigratingFetch(opts: { prm?: boolean; claimedIssuer?: Record<string, string> } = {}) {
            let active = AS_ONE;
            let rejecting: string | undefined;
            const registerCalls: string[] = [];
            const tokenCalls: Array<{ origin: string; body: URLSearchParams; authorization: string | null }> = [];
            const requests: string[] = [];
            const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
                const u = new URL(String(url));
                requests.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}`);
                if (u.pathname.includes('/.well-known/oauth-protected-resource')) {
                    if (opts.prm === false) return new Response(null, { status: 404 });
                    return Response.json({ resource: SERVER_URL, authorization_servers: [active] });
                }
                if (u.pathname.includes('/.well-known/')) {
                    return Response.json(asMetadata(opts.claimedIssuer?.[u.origin] ?? u.origin, u.origin));
                }
                if (u.pathname === '/register') {
                    registerCalls.push(u.origin);
                    return Response.json(
                        {
                            client_id: `cid-${u.host}`,
                            client_secret: `secret-${u.host}`,
                            redirect_uris: ['http://localhost:3000/callback']
                        },
                        { status: 201 }
                    );
                }
                if (u.pathname === '/token') {
                    const body = new URLSearchParams(String(init?.body));
                    tokenCalls.push({ origin: u.origin, body, authorization: new Headers(init?.headers).get('authorization') });
                    if (u.origin === rejecting) return new Response(null, { status: 404 });
                    return Response.json({ access_token: `at-${u.host}`, token_type: 'Bearer', refresh_token: `rt-${u.host}` });
                }
                return new Response(null, { status: 404 });
            };
            return {
                fetchFn,
                registerCalls,
                tokenCalls,
                requests,
                switchTo: (as: string) => (active = as),
                rejectTokenRequestsAt: (origin: string) => (rejecting = origin)
            };
        }

        type Stored = { info?: OAuthClientInformationMixed; tokens?: OAuthTokens };

        /** Single-slot provider that round-trips whatever auth() saves. */
        function createBlobProvider(withDiscoveryState = true): OAuthClientProvider & { redirected: URL[]; stored: Stored } {
            const stored: Stored = {};
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

        /** Whether `needle` appears in the body or Basic credentials of any recorded token request (optionally ignoring one origin). */
        const sentAnywhere = (srv: ReturnType<typeof createMigratingFetch>, needle: string, exceptOrigin?: string) =>
            srv.tokenCalls
                .filter(c => c.origin !== exceptOrigin)
                .some(
                    c =>
                        String(c.body).includes(needle) ||
                        (c.authorization !== null && atob(c.authorization.replace(/^Basic /, '')).includes(needle))
                );

        let warn: MockInstance<typeof console.warn>;
        beforeEach(() => {
            warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        });
        afterEach(() => {
            warn.mockRestore();
        });

        it('stamps the authorization server onto saved client information and tokens', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();

            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(provider.stored.info).toEqual(expect.objectContaining({ client_id: 'cid-as-one.example.com', issuer: AS_ONE }));

            expect(await auth(provider, { serverUrl: SERVER_URL, authorizationCode: 'code', fetchFn: srv.fetchFn })).toBe('AUTHORIZED');
            expect(provider.stored.tokens).toEqual({
                access_token: 'at-as-one.example.com',
                token_type: 'Bearer',
                refresh_token: 'rt-as-one.example.com',
                issuer: AS_ONE
            });
            expect(warn).not.toHaveBeenCalled();
        });

        it('a refresh token issued through AS-one is never posted to AS-two', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', client_secret: 'secret-one', issuer: AS_ONE };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-one', issuer: AS_ONE };
            srv.switchTo(AS_TWO);

            const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn });
            expect(srv.tokenCalls.filter(c => c.origin === AS_TWO)).toHaveLength(0);
            expect(sentAnywhere(srv, 'rt-one')).toBe(false);
            expect(sentAnywhere(srv, 'secret-one')).toBe(false);
            expect(result).toBe('REDIRECT');
            expect(provider.redirected.at(-1)?.origin).toBe(AS_TWO);
        });

        it('client information issued through AS-one is not reused at AS-two; the client re-registers', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();

            await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn });
            expect(srv.registerCalls).toEqual([AS_ONE]);

            srv.switchTo(AS_TWO);
            provider.invalidateCredentials?.('discovery');
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(srv.registerCalls).toEqual([AS_ONE, AS_TWO]);
            expect(provider.stored.info).toEqual(expect.objectContaining({ client_id: 'cid-as-two.example.com', issuer: AS_TWO }));
            expect(provider.redirected.at(-1)?.origin).toBe(AS_TWO);
            expect(provider.redirected.at(-1)?.searchParams.get('client_id')).toBe('cid-as-two.example.com');
        });

        it("the binding key is the discovery URL, not the metadata's issuer", async () => {
            const srv = createMigratingFetch({ claimedIssuer: { [AS_TWO]: AS_ONE } });
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', client_secret: 'secret-one', issuer: AS_ONE };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-one', issuer: AS_ONE };
            srv.switchTo(AS_TWO);

            const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn });
            expect(srv.tokenCalls).toHaveLength(0);
            expect(sentAnywhere(srv, 'rt-one')).toBe(false);
            expect(result).toBe('REDIRECT');
            expect(srv.registerCalls).toEqual([AS_TWO]);
        });

        it('the resource-origin fallback is a distinct binding key', async () => {
            const srv = createMigratingFetch({ prm: false });
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', client_secret: 'secret-one', issuer: AS_ONE };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-one', issuer: AS_ONE };

            const result = await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn });
            expect(srv.tokenCalls).toHaveLength(0);
            expect(result).toBe('REDIRECT');
            expect(srv.registerCalls).toEqual(['https://api.example.com']);
            expect(provider.stored.info?.issuer).toBe('https://api.example.com/');
        });

        it('unstamped stored credentials are bound on first use', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'legacy-cid', client_secret: 'legacy-secret' };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-legacy' };

            // First use: refreshed at the resolved authorization server and written back with its stamp.
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('AUTHORIZED');
            expect(srv.tokenCalls.map(c => c.origin)).toEqual([AS_ONE]);
            expect(provider.stored.info).toEqual({ client_id: 'legacy-cid', client_secret: 'legacy-secret', issuer: AS_ONE });
            expect(provider.stored.tokens?.issuer).toBe(AS_ONE);
            expect(srv.registerCalls).toHaveLength(0);
            expect(warn.mock.calls.filter(c => String(c[0]).includes("no 'issuer' property"))).toHaveLength(1);

            // From then on the stamp applies.
            srv.switchTo(AS_TWO);
            provider.invalidateCredentials?.('discovery');
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(srv.tokenCalls.filter(c => c.origin === AS_TWO)).toHaveLength(0);
            expect(sentAnywhere(srv, 'legacy-secret', AS_ONE)).toBe(false);
            expect(sentAnywhere(srv, 'rt-as-one.example.com')).toBe(false);
            expect(srv.registerCalls).toEqual([AS_TWO]);
        });

        it('unstamped stored credentials are only bound to an authorization server that accepted them', async () => {
            const srv = createMigratingFetch();
            let prmAvailable = false;
            const fetchFn = async (url: string | URL, init?: RequestInit) =>
                !prmAvailable && String(url).includes('oauth-protected-resource')
                    ? new Response(null, { status: 503 })
                    : srv.fetchFn(url, init);
            const provider = createBlobProvider(false);
            provider.stored.info = { client_id: 'legacy-cid', client_secret: 'legacy-secret', issuer: null as unknown as undefined };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-legacy' };

            // Discovery falls back to the resource origin, where the refresh is not accepted.
            srv.rejectTokenRequestsAt('https://api.example.com');
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe('REDIRECT');
            expect(provider.stored.info?.issuer).toBeNull();
            expect(provider.stored.tokens?.issuer).toBeUndefined();

            prmAvailable = true;
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe('AUTHORIZED');
            expect(srv.registerCalls).toEqual([]);
            expect(provider.stored.info?.issuer).toBe(AS_ONE);
            expect(provider.stored.tokens?.issuer).toBe(AS_ONE);
        });

        it('cached discovery state keeps its authorization server binding', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider();
            provider.stored.info = { client_id: 'cid', client_secret: 'secret-one', issuer: AS_ONE };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-one', issuer: AS_ONE };
            provider.saveDiscoveryState?.({ authorizationServerUrl: AS_ONE, authorizationServerMetadata: asMetadata(AS_ONE) });
            srv.switchTo(AS_TWO);

            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('AUTHORIZED');
            expect(srv.tokenCalls.map(c => c.origin)).toEqual([AS_ONE]);
            expect(srv.requests.some(r => r.includes(AS_TWO))).toBe(false);
        });

        it('a provider that cannot re-register reports the authorization server its client information is bound to', async () => {
            const srv = createMigratingFetch();
            const provider: OAuthClientProvider = { ...createBlobProvider(), saveClientInformation: undefined };
            provider.clientInformation = () => ({ client_id: 'cid', client_secret: 'secret-one', issuer: AS_ONE });
            srv.switchTo(AS_TWO);

            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).rejects.toThrow(
                `OAuth client information is bound to authorization server ${AS_ONE}`
            );
            expect(srv.tokenCalls).toHaveLength(0);
        });

        it('fetchToken sends nothing to an authorization server other than the one the client information is bound to', async () => {
            const srv = createMigratingFetch();
            const addClientAuthentication = vi.fn<NonNullable<OAuthClientProvider['addClientAuthentication']>>();
            const provider: OAuthClientProvider = { ...createBlobProvider(), addClientAuthentication };
            provider.clientInformation = () => ({ client_id: 'cid', client_secret: 'bound-secret', issuer: AS_ONE });

            await expect(
                fetchToken(provider, AS_TWO, { metadata: asMetadata(AS_TWO), authorizationCode: 'code', fetchFn: srv.fetchFn })
            ).rejects.toThrow(`OAuth client information is bound to authorization server ${AS_ONE}`);
            expect(srv.requests).toEqual([]);
            expect(addClientAuthentication).not.toHaveBeenCalled();

            // A matching stamp is used as before (one trailing slash is tolerated).
            provider.addClientAuthentication = undefined;
            await fetchToken(provider, `${AS_ONE}/`, { metadata: asMetadata(AS_ONE), authorizationCode: 'code', fetchFn: srv.fetchFn });
            expect(srv.tokenCalls.map(c => [c.origin, c.authorization])).toEqual([[AS_ONE, `Basic ${btoa('cid:bound-secret')}`]]);
            expect(warn).not.toHaveBeenCalled();
        });

        it('a provider that reads storage back through the SDK schemas keeps the binding', async () => {
            const storage = new Map<string, string>();
            const provider: OAuthClientProvider = {
                ...createBlobProvider(false),
                clientInformation: () =>
                    storage.has('info') ? OAuthClientInformationSchema.parseAsync(JSON.parse(storage.get('info')!)) : undefined,
                saveClientInformation: i => void storage.set('info', JSON.stringify(i)),
                tokens: () => (storage.has('tokens') ? OAuthTokensSchema.parseAsync(JSON.parse(storage.get('tokens')!)) : undefined),
                saveTokens: t => void storage.set('tokens', JSON.stringify(t))
            };
            const srv = createMigratingFetch();
            await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn });
            await auth(provider, { serverUrl: SERVER_URL, authorizationCode: 'code', fetchFn: srv.fetchFn });

            srv.switchTo(AS_TWO);
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(srv.tokenCalls.map(c => c.origin)).toEqual([AS_ONE]);
            expect(warn).not.toHaveBeenCalled();
        });

        it('an issuer property in a registration or token response does not become the stamp', async () => {
            const srv = createMigratingFetch();
            const fetchFn = async (url: string | URL, init?: RequestInit) => {
                const response = await srv.fetchFn(url, init);
                return init?.method === 'POST' ? Response.json({ ...(await response.json()), issuer: AS_ONE }, response) : response;
            };
            const provider = createBlobProvider(false);
            srv.switchTo(AS_TWO);

            await auth(provider, { serverUrl: SERVER_URL, fetchFn });
            await auth(provider, { serverUrl: SERVER_URL, authorizationCode: 'code', fetchFn });
            expect(provider.stored.info?.issuer).toBe(AS_TWO);
            expect(provider.stored.tokens?.issuer).toBe(AS_TWO);
        });

        it('an issuer that is not a string is dropped from a response, and an empty stored one matches nothing', async () => {
            expect(OAuthTokensSchema.parse({ access_token: 'at', token_type: 'Bearer', issuer: null })).toEqual({
                access_token: 'at',
                token_type: 'Bearer'
            });
            expect(OAuthClientInformationSchema.parse({ client_id: 'cid', issuer: 5 })).toEqual({ client_id: 'cid' });

            const srv = createMigratingFetch();
            const provider: OAuthClientProvider = { ...createBlobProvider(false), saveClientInformation: undefined };
            provider.clientInformation = () => ({ client_id: 'cid', client_secret: 'secret-one', issuer: '' });
            await expect(auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).rejects.toThrow(
                'OAuth client information is bound'
            );
            expect(srv.tokenCalls).toEqual([]);
        });

        it('binding unstamped client information never fails a flow that worked without it', async () => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider(false);
            provider.stored.info = { client_id: 'pre-registered' };
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt-legacy' };
            provider.saveClientInformation = vi.fn(() => {
                throw new Error('client is pre-registered');
            });

            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('AUTHORIZED');
            expect(provider.saveClientInformation).toHaveBeenCalledWith({ client_id: 'pre-registered', issuer: AS_ONE });
            expect(provider.stored.tokens?.issuer).toBe(AS_ONE);
        });

        it('a provider whose storage getters return null is treated as having nothing stored', async () => {
            // The `JSON.parse(storage.getItem(key))` idiom yields `null`, not `undefined`, for an empty slot.
            const storage = new Map<string, string>();
            const read = (key: string) => JSON.parse(storage.get(key) ?? 'null');
            const provider: OAuthClientProvider = {
                ...createBlobProvider(),
                clientInformation: () => read('info'),
                saveClientInformation: i => void storage.set('info', JSON.stringify(i)),
                tokens: () => read('tokens'),
                saveTokens: t => void storage.set('tokens', JSON.stringify(t))
            };
            const srv = createMigratingFetch();

            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(srv.registerCalls).toEqual([AS_ONE]);
            expect(read('info')).toEqual(expect.objectContaining({ client_id: 'cid-as-one.example.com', issuer: AS_ONE }));

            // Registered, still no tokens: a fresh authorization is started again.
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('REDIRECT');
            expect(srv.registerCalls).toEqual([AS_ONE]);

            // Without saveClientInformation the pre-existing registration error is reported unchanged.
            storage.clear();
            const preRegisteredOnly: OAuthClientProvider = { ...provider, saveClientInformation: undefined };
            await expect(auth(preRegisteredOnly, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).rejects.toThrow(
                'OAuth client information must be saveable for dynamic registration'
            );

            // fetchToken sends the request without client authentication rather than failing.
            await fetchToken(provider, AS_ONE, {
                metadata: asMetadata(AS_ONE),
                authorizationCode: 'code',
                fetchFn: srv.fetchFn
            });
            expect(srv.tokenCalls.at(-1)?.authorization).toBeNull();
        });

        it.each(['https://other.example.com', 42])('an issuer of %j in a token or registration response is not returned', async issuer => {
            const srv = createMigratingFetch();
            const fetchFn = async (url: string | URL, init?: RequestInit) => {
                const response = await srv.fetchFn(url, init);
                return init?.method === 'POST' ? Response.json({ ...(await response.json()), issuer }, response) : response;
            };
            const metadata = asMetadata(AS_ONE);
            const clientInformation = { client_id: 'cid' };
            const provider: OAuthClientProvider = {
                ...createBlobProvider(false),
                clientInformation: () => clientInformation,
                prepareTokenRequest: () => new URLSearchParams({ grant_type: 'client_credentials' })
            };

            const results = [
                await registerClient(AS_ONE, { metadata, clientMetadata: { redirect_uris: [] }, fetchFn }),
                await exchangeAuthorization(AS_ONE, {
                    metadata,
                    clientInformation,
                    authorizationCode: 'code',
                    codeVerifier: 'v',
                    redirectUri: 'http://localhost:3000/callback',
                    fetchFn
                }),
                await refreshAuthorization(AS_ONE, { metadata, clientInformation, refreshToken: 'rt', fetchFn }),
                await fetchToken(provider, AS_ONE, { metadata, fetchFn })
            ];
            for (const result of results) {
                expect(result).not.toHaveProperty('issuer');
            }
        });

        it('a stamp and the authorization server are compared as parsed URLs', async () => {
            const requestsSent = async (issuer: string, authorizationServerUrl: string) => {
                const srv = createMigratingFetch();
                const provider: OAuthClientProvider = {
                    ...createBlobProvider(false),
                    clientInformation: () => ({ client_id: 'cid', client_secret: 'bound-secret', issuer })
                };
                const options = { metadata: asMetadata(AS_ONE), authorizationCode: 'code', fetchFn: srv.fetchFn };
                await fetchToken(provider, authorizationServerUrl, options).catch(() => {});
                return [issuer, authorizationServerUrl, srv.tokenCalls.length];
            };

            for (const [issuer, url] of [
                ['https://AS-ONE.example.com', AS_ONE],
                ['HTTPS://as-one.example.com:443', AS_ONE],
                [AS_ONE, 'https://AS-ONE.example.com/'],
                [AS_ONE, 'https://as-one.example.com:443'],
                ['https://as-one.example.com/a/./b', 'https://as-one.example.com/a/b/'],
                ['as-one.example.com', 'as-one.example.com/']
            ]) {
                expect(await requestsSent(issuer, url)).toEqual([issuer, url, 1]);
            }

            // Another scheme, host, port or path is another authorization server.
            for (const [issuer, url] of [
                [AS_ONE, 'http://as-one.example.com'],
                [AS_ONE, 'https://as-one.example.com.'],
                [AS_ONE, 'https://as-one.example.com.example.org'],
                [AS_ONE, 'https://as-one.example.com@example.org'],
                [AS_ONE, 'https://a@as-one.example.com'],
                [AS_ONE, 'https://as-one.example.com/#f'],
                [AS_ONE, 'https://as-one.example.com:8443'],
                [AS_ONE, 'https://as-one.example.com/tenant'],
                ['https://as-one.example.com/Tenant', 'https://as-one.example.com/tenant'],
                ['https://as-one.example.com/tenant', 'https://as-one.example.com/tenant//'],
                ['https://as-one.example.com/?tenant=a', 'https://as-one.example.com/?tenant=b'],
                ['as-one.example.com', AS_ONE]
            ]) {
                expect(await requestsSent(issuer, url)).toEqual([issuer, url, 0]);
            }
        });

        const notStrings = [{ issuer: 42 }, { issuer: false }, { issuer: { href: AS_ONE } }, { issuer: [AS_ONE] }];
        it.each(notStrings)('a stored issuer of $issuer counts as no stamp', async ({ issuer }) => {
            const srv = createMigratingFetch();
            const provider = createBlobProvider(false);
            provider.stored.info = { client_id: 'cid', client_secret: 's', issuer } as unknown as OAuthClientInformationMixed;
            provider.stored.tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', issuer } as unknown as OAuthTokens;

            await fetchToken(provider, AS_ONE, { metadata: asMetadata(AS_ONE), authorizationCode: 'code', fetchFn: srv.fetchFn });
            expect(srv.tokenCalls.map(c => c.authorization)).toEqual([`Basic ${btoa('cid:s')}`]);

            // auth() binds it after its first successful use, as it does for a value with no stamp.
            expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn: srv.fetchFn })).toBe('AUTHORIZED');
            expect(provider.stored.info?.issuer).toBe(AS_ONE);
            expect(provider.stored.tokens?.issuer).toBe(AS_ONE);
        });

        it('fetchToken uses client information that the provider fills in while preparing the request', async () => {
            const srv = createMigratingFetch();
            let filled: OAuthClientInformationMixed | undefined;
            const prepareTokenRequest = vi.fn(() => {
                filled = { client_id: 'cid', client_secret: 'lazy-secret', issuer: AS_ONE };
                return new URLSearchParams({ grant_type: 'client_credentials' });
            });
            const provider: OAuthClientProvider = { ...createBlobProvider(false), clientInformation: () => filled, prepareTokenRequest };

            await fetchToken(provider, AS_ONE, { metadata: asMetadata(AS_ONE), fetchFn: srv.fetchFn });
            expect(srv.tokenCalls.map(c => [c.origin, c.authorization])).toEqual([[AS_ONE, `Basic ${btoa('cid:lazy-secret')}`]]);

            // The value read after preparing goes through the same check.
            filled = undefined;
            await expect(fetchToken(provider, AS_TWO, { metadata: asMetadata(AS_TWO), fetchFn: srv.fetchFn })).rejects.toThrow(
                `OAuth client information is bound to authorization server ${AS_ONE}`
            );
            expect(srv.tokenCalls).toHaveLength(1);

            // A value that is there before preparing is checked before the request is prepared.
            prepareTokenRequest.mockClear();
            await expect(fetchToken(provider, AS_TWO, { metadata: asMetadata(AS_TWO), fetchFn: srv.fetchFn })).rejects.toThrow(
                `OAuth client information is bound to authorization server ${AS_ONE}`
            );
            expect(prepareTokenRequest).not.toHaveBeenCalled();
            expect(srv.tokenCalls).toHaveLength(1);
        });
    });
});
