import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/core';

import type { OAuthRegisteredClientsStore } from '../../../../src/server/auth/clients.js';
import { authorizationHandler } from '../../../../src/server/auth/handlers/authorize.js';
import type { AuthorizationParams, OAuthServerProvider } from '../../../../src/server/auth/provider.js';

describe('authorizationHandler (web)', () => {
    const validClient: OAuthClientInformationFull = {
        client_id: 'valid-client',
        client_secret: 'valid-secret',
        redirect_uris: ['https://example.com/callback']
    };

    const multiRedirectClient: OAuthClientInformationFull = {
        client_id: 'multi-redirect-client',
        client_secret: 'valid-secret',
        redirect_uris: ['https://example.com/callback1', 'https://example.com/callback2']
    };

    const clientsStore: OAuthRegisteredClientsStore = {
        async getClient(clientId: string) {
            if (clientId === 'valid-client') return validClient;
            if (clientId === 'multi-redirect-client') return multiRedirectClient;
            return undefined;
        }
    };

    const provider: OAuthServerProvider = {
        clientsStore,
        async authorize(_client, params: AuthorizationParams): Promise<Response> {
            const u = new URL(params.redirectUri);
            u.searchParams.set('code', 'mock_auth_code');
            if (params.state) u.searchParams.set('state', params.state);
            return Response.redirect(u.toString(), 302);
        },
        async challengeForAuthorizationCode(): Promise<string> {
            return 'mock_challenge';
        },
        async exchangeAuthorizationCode(): Promise<OAuthTokens> {
            return {
                access_token: 'mock_access_token',
                token_type: 'bearer',
                expires_in: 3600,
                refresh_token: 'mock_refresh_token'
            };
        },
        async exchangeRefreshToken(): Promise<OAuthTokens> {
            return {
                access_token: 'new_mock_access_token',
                token_type: 'bearer',
                expires_in: 3600,
                refresh_token: 'new_mock_refresh_token'
            };
        },
        async verifyAccessToken() {
            throw new Error('not used');
        }
    };

    it('returns 405 for unsupported methods', async () => {
        const handler = authorizationHandler({ provider });
        const res = await handler(new Request('http://localhost/authorize', { method: 'PUT' }));
        expect(res.status).toBe(405);
    });

    it('returns 400 if client does not exist', async () => {
        const handler = authorizationHandler({ provider });
        const res = await handler(
            new Request(
                'http://localhost/authorize?client_id=missing&response_type=code&code_challenge=x&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
                { method: 'GET' }
            )
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: 'invalid_client' }));
    });

    it('redirects with a code on valid request (single redirect_uri inferred)', async () => {
        const handler = authorizationHandler({ provider });
        const res = await handler(
            new Request(
                'http://localhost/authorize?client_id=valid-client&response_type=code&code_challenge=challenge123&code_challenge_method=S256',
                { method: 'GET' }
            )
        );
        expect(res.status).toBe(302);
        const location = res.headers.get('location')!;
        expect(location).toContain('https://example.com/callback');
        expect(location).toContain('code=mock_auth_code');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('requires redirect_uri if client has multiple redirect URIs', async () => {
        const handler = authorizationHandler({ provider });
        const res = await handler(
            new Request(
                'http://localhost/authorize?client_id=multi-redirect-client&response_type=code&code_challenge=challenge123&code_challenge_method=S256',
                { method: 'GET' }
            )
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: 'invalid_request' }));
    });
});
