import { authorizationHandler, AuthorizationHandlerOptions, redirectUriMatches } from '../../src/handlers/authorize.js';
import { OAuthServerProvider, AuthorizationParams } from '../../src/provider.js';
import { OAuthRegisteredClientsStore } from '../../src/clients.js';
import { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/core';
import express, { Response } from 'express';
import supertest from 'supertest';
import { AuthInfo } from '../../src/types.js';
import { InvalidTokenError } from '../../src/errors.js';

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

    // Native app client with a portless loopback redirect (e.g., from CIMD / SEP-991)
    const loopbackClient: OAuthClientInformationFull = {
        client_id: 'loopback-client',
        client_secret: 'valid-secret',
        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
        scope: 'profile email'
    };

    // Mock client store
    const mockClientStore: OAuthRegisteredClientsStore = {
        async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
            if (clientId === 'valid-client') {
                return validClient;
            } else if (clientId === 'multi-redirect-client') {
                return multiRedirectClient;
            } else if (clientId === 'loopback-client') {
                return loopbackClient;
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
            const location = new URL(response.header.location!);
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
            const location = new URL(response.header.location!);
            expect(location.origin + location.pathname).toBe('https://example.com/callback');
        });

        // RFC 8252 §7.3: authorization servers MUST allow any port for loopback
        // redirect URIs. Native apps obtain ephemeral ports from the OS.
        it('accepts loopback redirect_uri with ephemeral port (RFC 8252)', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'loopback-client',
                redirect_uri: 'http://localhost:53428/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(302);
            const location = new URL(response.header.location!);
            expect(location.hostname).toBe('localhost');
            expect(location.port).toBe('53428');
            expect(location.pathname).toBe('/callback');
        });

        it('accepts 127.0.0.1 loopback redirect_uri with ephemeral port (RFC 8252)', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'loopback-client',
                redirect_uri: 'http://127.0.0.1:9000/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(302);
        });

        it('rejects loopback redirect_uri with different path', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'loopback-client',
                redirect_uri: 'http://localhost:53428/evil',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(400);
        });

        it('does not relax port for non-loopback redirect_uri', async () => {
            const response = await supertest(app).get('/authorize').query({
                client_id: 'valid-client',
                redirect_uri: 'https://example.com:8443/callback',
                response_type: 'code',
                code_challenge: 'challenge123',
                code_challenge_method: 'S256'
            });

            expect(response.status).toBe(400);
        });
    });

    describe('redirectUriMatches (RFC 8252 §7.3)', () => {
        it('exact match passes', () => {
            expect(redirectUriMatches('https://example.com/cb', 'https://example.com/cb')).toBe(true);
        });

        it('loopback: any port matches portless registration', () => {
            expect(redirectUriMatches('http://localhost:53428/callback', 'http://localhost/callback')).toBe(true);
            expect(redirectUriMatches('http://127.0.0.1:8080/callback', 'http://127.0.0.1/callback')).toBe(true);
            expect(redirectUriMatches('http://[::1]:9000/cb', 'http://[::1]/cb')).toBe(true);
        });

        it('loopback: any port matches ported registration', () => {
            expect(redirectUriMatches('http://localhost:53428/callback', 'http://localhost:3118/callback')).toBe(true);
        });

        it('loopback: different path rejected', () => {
            expect(redirectUriMatches('http://localhost:53428/evil', 'http://localhost/callback')).toBe(false);
        });

        it('loopback: different scheme rejected', () => {
            expect(redirectUriMatches('https://localhost:53428/callback', 'http://localhost/callback')).toBe(false);
        });

        it('loopback: localhost↔127.0.0.1 cross-match rejected', () => {
            // RFC 8252 relaxes port only, not host
            expect(redirectUriMatches('http://127.0.0.1:53428/callback', 'http://localhost/callback')).toBe(false);
        });

        it('non-loopback: port must match exactly', () => {
            expect(redirectUriMatches('https://example.com:8443/cb', 'https://example.com/cb')).toBe(false);
        });

        it('non-loopback: no relaxation for private IPs', () => {
            expect(redirectUriMatches('http://192.168.1.1:8080/cb', 'http://192.168.1.1/cb')).toBe(false);
        });

        it('malformed URIs rejected', () => {
            expect(redirectUriMatches('not a url', 'http://localhost/cb')).toBe(false);
            expect(redirectUriMatches('http://localhost/cb', 'not a url')).toBe(false);
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
            const location = new URL(response.header.location!);
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
            const location = new URL(response.header.location!);
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
            const location = new URL(response.header.location!);
            expect(location.searchParams.get('error')).toBe('invalid_request');
        });
    });

    describe('Resource parameter validation', () => {
        it('propagates resource parameter', async () => {
            const mockProviderWithResource = vi.spyOn(mockProvider, 'authorize');

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
            const location = new URL(response.header.location!);
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
            const location = new URL(response.header.location!);
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
            const location = new URL(response.header.location!);
            expect(location.searchParams.has('code')).toBe(true);
        });
    });
});
