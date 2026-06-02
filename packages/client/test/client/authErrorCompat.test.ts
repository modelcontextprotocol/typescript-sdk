import {
    InvalidGrantError,
    InvalidScopeError,
    isTransientOAuthError,
    OAuthError,
    ServerError,
    TemporarilyUnavailableError
} from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth.js';
import { auth, parseErrorResponse, refreshAuthorization } from '../../src/client/auth.js';

describe('parseErrorResponse error-class compatibility', () => {
    it('returns the specific subclass for known OAuth error codes', async () => {
        const response = new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), {
            status: 400
        });
        const error = await parseErrorResponse(response);
        expect(error).toBeInstanceOf(InvalidGrantError);
        expect(error.code).toBe('invalid_grant');
        expect(isTransientOAuthError(error)).toBe(false);
    });

    it('preserves unknown error codes on the base class and classifies them transient', async () => {
        const response = new Response(JSON.stringify({ error: 'invalid_refresh_token', error_description: 'rotated' }), {
            status: 400
        });
        const error = await parseErrorResponse(response);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('invalid_refresh_token');
        expect(isTransientOAuthError(error)).toBe(true);
    });

    it('falls back to ServerError for unparsable bodies, matching 1.x', async () => {
        const response = new Response('<html>gateway timeout</html>', { status: 502 });
        const error = await parseErrorResponse(response);
        expect(error).toBeInstanceOf(ServerError);
        expect(isTransientOAuthError(error)).toBe(true);
    });
});

describe('refreshAuthorization error-class compatibility', () => {
    const metadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code']
    };
    const clientInformation = {
        client_id: 'client123',
        client_secret: 'secret123',
        redirect_uris: ['http://localhost:3000/callback']
    };

    function refreshWith(fetchFn: typeof fetch) {
        return refreshAuthorization('https://auth.example.com', {
            metadata,
            clientInformation,
            refreshToken: 'refresh123',
            fetchFn
        });
    }

    it('throws InvalidGrantError when the token endpoint rejects the refresh token', async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), { status: 400 })
        );
        const error = await refreshWith(fetchFn).catch(e => e);
        expect(error).toBeInstanceOf(InvalidGrantError);
        expect(error.code).toBe('invalid_grant');
        expect(isTransientOAuthError(error)).toBe(false);
    });

    it('preserves unknown token-endpoint error codes and classifies them transient', async () => {
        const fetchFn = vi.fn(
            async () => new Response(JSON.stringify({ error: 'invalid_refresh_token', error_description: 'rotated' }), { status: 400 })
        );
        const error = await refreshWith(fetchFn).catch(e => e);
        expect(error).toBeInstanceOf(OAuthError);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('invalid_refresh_token');
        expect(isTransientOAuthError(error)).toBe(true);
    });

    it('throws TemporarilyUnavailableError for a 503 with the matching code', async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }));
        const error = await refreshWith(fetchFn).catch(e => e);
        expect(error).toBeInstanceOf(TemporarilyUnavailableError);
        expect(isTransientOAuthError(error)).toBe(true);
    });
});
describe('auth() refresh-failure fallback', () => {
    function makeProvider(): OAuthClientProvider {
        return {
            get redirectUrl() {
                return 'http://localhost:3000/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost:3000/callback'], client_name: 'Test Client' };
            },
            clientInformation: vi.fn().mockResolvedValue({
                client_id: 'client123',
                client_secret: 'secret123',
                redirect_uris: ['http://localhost:3000/callback']
            }),
            tokens: vi.fn().mockResolvedValue({ access_token: 'stale', refresh_token: 'refresh123', token_type: 'bearer' }),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn()
        };
    }

    function fetchRouter(tokenResponse: () => Response): typeof fetch {
        return vi.fn(async (url: string | URL | Request) => {
            const urlString = url.toString();
            if (urlString.includes('/.well-known/oauth-protected-resource')) {
                return new Response(
                    JSON.stringify({ resource: 'https://api.example.com/mcp', authorization_servers: ['https://auth.example.com'] }),
                    { status: 200 }
                );
            }
            if (urlString.includes('/.well-known/oauth-authorization-server')) {
                return new Response(
                    JSON.stringify({
                        issuer: 'https://auth.example.com',
                        authorization_endpoint: 'https://auth.example.com/authorize',
                        token_endpoint: 'https://auth.example.com/token',
                        response_types_supported: ['code'],
                        code_challenge_methods_supported: ['S256']
                    }),
                    { status: 200 }
                );
            }
            if (urlString.includes('/token')) {
                return tokenResponse();
            }
            throw new Error(`Unexpected fetch call: ${urlString}`);
        }) as unknown as typeof fetch;
    }

    it('falls through to a fresh authorization flow when refresh fails with an unknown code', async () => {
        const provider = makeProvider();
        const result = await auth(provider, {
            serverUrl: 'https://api.example.com/mcp',
            fetchFn: fetchRouter(
                () => new Response(JSON.stringify({ error: 'invalid_refresh_token', error_description: 'rotated' }), { status: 400 })
            )
        });
        expect(result).toBe('REDIRECT');
        expect(provider.redirectToAuthorization).toHaveBeenCalledTimes(1);
        expect(provider.saveTokens).not.toHaveBeenCalled();
    });

    it('still escalates known non-transient refresh failures', async () => {
        const provider = makeProvider();
        const error = await auth(provider, {
            serverUrl: 'https://api.example.com/mcp',
            fetchFn: fetchRouter(
                () => new Response(JSON.stringify({ error: 'invalid_scope', error_description: 'scope revoked' }), { status: 400 })
            )
        }).catch(e => e);
        expect(error).toBeInstanceOf(InvalidScopeError);
        expect(error.code).toBe('invalid_scope');
        expect(provider.redirectToAuthorization).not.toHaveBeenCalled();
    });
});
