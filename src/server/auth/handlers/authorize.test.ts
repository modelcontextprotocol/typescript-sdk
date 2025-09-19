import { authorizationHandler, AuthorizationHandlerOptions } from './authorize.js';
import { OAuthServerProvider, AuthorizationParams } from '../provider.js';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { OAuthClientInformationFull, OAuthTokens } from '../../../shared/auth.js';
import express, { Response } from 'express';
import supertest from 'supertest';
import { AuthInfo } from '../types.js';
import { InvalidTokenError } from '../errors.js';

describe('Authorization Handler', () => {
    // Mock client data
    const validClient: OAuthClientInformationFull = {
        client_id: 'valid-client',
        client_secret: 'valid-secret',
        redirect_uris: ['https://example.com/callback'],
        scope: 'profile email'
    };

    const multiRedirectClient: OAuthClientInformationFull = {
        client_id: 'multi-redirect-client',
        client_secret: 'valid-secret',
        redirect_uris: ['https://example.com/callback1', 'https://example.com/callback2'],
        scope: 'profile email'
    };

    // Mock client store
    const mockClientStore: OAuthRegisteredClientsStore = {
        async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
            if (clientId === 'valid-client') {
                return validClient;
            } else if (clientId === 'multi-redirect-client') {
                return multiRedirectClient;
            }
            return undefined;
        }
    };

    // Mock provider
    const mockProvider: OAuthServerProvider = {
        clientsStore: mockClientStore,

        async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
            // Mock implementation - redirects to redirectUri with code and state
            const redirectUrl = new URL(params.redirectUri);
            redirectUrl.searchParams.set('code', 'mock_auth_code');
            if (params.state) {
                redirectUrl.searchParams.set('state', params.state);
            }
            res.redirect(302, redirectUrl.toString());
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

        async verifyAccessToken(token: string): Promise<AuthInfo> {
            if (token === 'valid_token') {
                return {
                    token,
                    clientId: 'valid-client',
                    scopes: ['read', 'write'],
                    expiresAt: Date.now() / 1000 + 3600
                };
            }
            throw new InvalidTokenError('Token is invalid or expired');
        },

        async revokeToken(): Promise<void> {
            // Do nothing in mock
        }
    };

    // Setup express app with handler
    let app: express.Express;
    let options: AuthorizationHandlerOptions;

    beforeEach(() => {
        app = express();
        options = { provider: mockProvider };
        const handler = authorizationHandler(options);
        app.use('/authorize', handler);
    });

    describe('HTTP method validation', () => {
        it('rejects non-GET/POST methods', async () => {
            const response = await supertest(app).put('/authorize').query({ client_id: 'valid-client' });

            expect(response.status).toBe(405); // Method not allowed response from handler
        });
    });

    describe('Client validation', () => {
        it('requires client_id parameter', async () => {
            const response = await supertest(app).get('/authorize');

            expect(response.status).toBe(400);
            expect(response.text).toContain('client_id');
        });

        it('validates that client exists', async () => {
            const response = await supertest(app).get('/authorize').query({ client_id: 'nonexistent-client' });

            expect(response.status).toBe(400);
        });
    });

    describe('Redirect URI validation', () => {
        it('uses the only redirect_uri if client has just one and none provided', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.origin + location.pathname).toBe('https://example.com/callback');
        });

        it('requires redirect_uri if client has multiple', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'multi-redirect-client',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(400);
        });

        it('validates redirect_uri against client registered URIs', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://malicious.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(400);
        });

        it('accepts valid redirect_uri that client registered with', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.origin + location.pathname).toBe('https://example.com/callback');
        });
    });

    describe('Authorization request validation', () => {
        it('requires response_type=code', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'token', // invalid - we only support code flow
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.get('error')).toBe('invalid_request');
        });

        it('requires code_challenge parameter', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge_method: 'S256'
                // Missing code_challenge
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.get('error')).toBe('invalid_request');
        });

        it('requires code_challenge_method=S256', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'plain' // Only S256 is supported
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.get('error')).toBe('invalid_request');
        });
    });

    describe('Scope validation', () => {
        it('validates requested scopes against client registered scopes', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256',
                scope: 'profile email admin' // 'admin' not in client scopes
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.get('error')).toBe('invalid_scope');
        });

        it('accepts valid scopes subset', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256',
                scope: 'profile' // subset of client scopes
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.has('code')).toBe(true);
        });
    });

    describe('Resource parameter validation', () => {
        it('propagates resource parameter', async () => {
            const mockProviderWithResource = jest.spyOn(mockProvider, 'authorize');

            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256',
                resource: 'https://api.example.com/resource'
            });

            expect(response.status).toBe(302);
            expect(mockProviderWithResource).toHaveBeenCalledWith(
                validClient,
                expect.objectContaining({
                    resource: new URL('https://api.example.com/resource'),
                    redirectUri: 'https://example.com/callback',
                    codeChallenge: 'challenge123'
                }),
                expect.any(Object)
            );
        });
    });

    describe('Successful authorization', () => {
        it('handles successful authorization with all parameters', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256',
                scope: 'profile email',
                state: 'xyz789'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.origin + location.pathname).toBe('https://example.com/callback');
            expect(location.searchParams.get('code')).toBe('mock_auth_code');
            expect(location.searchParams.get('state')).toBe('xyz789');
        });

        it('preserves state parameter in response', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256',
                state: 'state-value-123'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.get('state')).toBe('state-value-123');
        });

        it('handles POST requests the same as GET', async () => {
            const response = await supertest(app).post('/authorize').type('form').send({
                client_id: 'valid-client',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location);
            expect(location.searchParams.has('code')).toBe(true);
        });
    });
});
