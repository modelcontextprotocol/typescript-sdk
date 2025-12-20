import type { AuthInfo, OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/core';
import { InvalidGrantError } from '@modelcontextprotocol/core';
import * as pkceChallenge from 'pkce-challenge';

import type { OAuthRegisteredClientsStore } from '../../../../src/server/auth/clients.js';
import { tokenHandler } from '../../../../src/server/auth/handlers/token.js';
import type { AuthorizationParams, OAuthServerProvider } from '../../../../src/server/auth/provider.js';

vi.mock('pkce-challenge', () => ({
    verifyChallenge: vi.fn()
}));

describe('tokenHandler (web)', () => {
    const validClient: OAuthClientInformationFull = {
        client_id: 'valid-client',
        client_secret: 'valid-secret',
        redirect_uris: ['https://example.com/callback']
    };

    const clientsStore: OAuthRegisteredClientsStore = {
        async getClient(clientId: string) {
            return clientId === 'valid-client' ? validClient : undefined;
        }
    };

    const provider: OAuthServerProvider = {
        clientsStore,
        async authorize(_client: OAuthClientInformationFull, _params: AuthorizationParams): Promise<Response> {
            return Response.redirect('https://example.com/callback?code=mock_auth_code', 302);
        },
        async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
            if (authorizationCode === 'valid_code') return 'mock_challenge';
            throw new InvalidGrantError('The authorization code is invalid');
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
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            return {
                token,
                clientId: 'valid-client',
                scopes: [],
                expiresAt: Math.floor(Date.now() / 1000) + 3600
            };
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns tokens for authorization_code grant when PKCE passes', async () => {
        (pkceChallenge.verifyChallenge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        const handler = tokenHandler({ provider });

        const body = new URLSearchParams({
            client_id: 'valid-client',
            client_secret: 'valid-secret',
            grant_type: 'authorization_code',
            code: 'valid_code',
            code_verifier: 'valid_verifier'
        }).toString();

        const res = await handler(
            new Request('http://localhost/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            })
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(
            expect.objectContaining({
                access_token: 'mock_access_token'
            })
        );
    });

    it('returns 400 when PKCE fails', async () => {
        (pkceChallenge.verifyChallenge as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const handler = tokenHandler({ provider });

        const body = new URLSearchParams({
            client_id: 'valid-client',
            client_secret: 'valid-secret',
            grant_type: 'authorization_code',
            code: 'valid_code',
            code_verifier: 'bad_verifier'
        }).toString();

        const res = await handler(
            new Request('http://localhost/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            })
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: 'invalid_grant' }));
    });
});
