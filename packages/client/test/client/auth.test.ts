import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/core';
import { InvalidClientMetadataError, LATEST_PROTOCOL_VERSION, ServerError } from '@modelcontextprotocol/core';
import { expect, type Mock, vi } from 'vitest';

import {
    auth,
    buildDiscoveryUrls,
    discoverAuthorizationServerMetadata,
    discoverOAuthMetadata,
    discoverOAuthProtectedResourceMetadata,
    exchangeAuthorization,
    extractWWWAuthenticateParams,
    isHttpsUrl,
    type OAuthClientProvider,
    refreshAuthorization,
    registerClient,
    selectClientAuthMethod,
    startAuthorization
} from '../../src/client/auth.js';
import { createPrivateKeyJwtAuth } from '../../src/client/auth-extensions.js';

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
            const [url] = calls[0]!;
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
            expect(mockFetch.mock.calls[0]![1]?.headers).toHaveProperty('MCP-Protocol-Version');
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
            const [lastUrl, lastOptions] = calls[2]!;
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
            expect(mockFetch.mock.calls[0]![1]?.headers).toHaveProperty('MCP-Protocol-Version');
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

        it('returns undefined when all URLs fail with CORS errors', async () => {
            // All fetch attempts fail with CORS errors (TypeError)
            mockFetch.mockImplementation(() => Promise.reject(new TypeError('CORS error')));

            const metadata = await discoverAuthorizationServerMetadata('https://auth.example.com/tenant1');

            expect(metadata).toBeUndefined();

            // Verify that all discovery URLs were attempted
            expect(mockFetch).toHaveBeenCalledTimes(6); // 3 URLs × 2 attempts each (with and without headers)
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
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
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

            const options = mockFetch.mock.calls[0]![1];
            expect(options.headers).toBeInstanceOf(Headers);
            expect(options.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');

            const body = options.body as URLSearchParams;
            expect(body.get('grant_type')).toBe('authorization_code');
            expect(body.get('code')).toBe('code123');
            expect(body.get('code_verifier')).toBe('verifier123');
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
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
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
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
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
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
            const redirectCall = (mockProvider.redirectToAuthorization as Mock).mock.calls[0]!;
            const authUrl: URL = redirectCall[0];
            expect(authUrl?.searchParams.get('scope')).toBe('mcp:read mcp:write mcp:admin');
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

        it('defaults to client_secret_post when no auth methods specified', async () => {
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

            // Check headers
            expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
            expect(request.headers.get('Authorization')).toBeNull();

            const body = request.body as URLSearchParams;
            expect(body.get('client_id')).toBe('client123');
            expect(body.get('client_secret')).toBe('secret123');
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
            const { createFetchWithInit } = await import('@modelcontextprotocol/core');

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
            const { createFetchWithInit } = await import('@modelcontextprotocol/core');

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
            const { createFetchWithInit } = await import('@modelcontextprotocol/core');

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

            // Should save URL-based client info
            expect(mockProvider.saveClientInformation).toHaveBeenCalledWith({
                client_id: 'https://example.com/client-metadata.json'
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
                redirect_uris: ['http://localhost:3000/callback']
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
                redirect_uris: ['http://localhost:3000/callback']
            });
        });
    });
});
