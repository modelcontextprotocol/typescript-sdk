import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/core';

import type { OAuthRegisteredClientsStore } from '../../../../src/server/auth/clients.js';
import { revocationHandler } from '../../../../src/server/auth/handlers/revoke.js';
import type { AuthorizationParams, OAuthServerProvider } from '../../../../src/server/auth/provider.js';

describe('revocationHandler (web)', () => {
    it('returns 200 on successful revocation', async () => {
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
                return Response.redirect('https://example.com', 302);
            },
            async challengeForAuthorizationCode(): Promise<string> {
                return 'mock';
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
            },
            async revokeToken(_client: OAuthClientInformationFull, _request: OAuthTokenRevocationRequest): Promise<void> {
                // ok
            }
        };

        const handler = revocationHandler({ provider, rateLimit: false });

        const body = new URLSearchParams({
            client_id: 'valid-client',
            client_secret: 'valid-secret',
            token: 'token_to_revoke'
        }).toString();

        const res = await handler(
            new Request('http://localhost/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body
            })
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
    });
});
