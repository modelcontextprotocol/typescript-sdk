import { Response } from 'express';
import { DemoInMemoryAuthProvider, DemoInMemoryClientsStore } from './demoInMemoryOAuthProvider.js';
import { AuthorizationParams } from '../../server/auth/provider.js';
import { OAuthClientInformationFull } from '../../shared/auth.js';
import { InvalidRequestError } from '../../server/auth/errors.js';

describe('DemoInMemoryAuthProvider', () => {
    let provider: DemoInMemoryAuthProvider;
    let mockResponse: Response & { getRedirectUrl: () => string };

    const createMockResponse = (): Response & { getRedirectUrl: () => string } => {
        let capturedRedirectUrl: string | undefined;

        const mockRedirect = jest.fn().mockImplementation((url: string | number, status?: number) => {
            if (typeof url === 'string') {
                capturedRedirectUrl = url;
            } else if (typeof status === 'string') {
                capturedRedirectUrl = status;
            }
            return mockResponse;
        });

        const mockResponse = {
            redirect: mockRedirect,
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            send: jest.fn().mockReturnThis(),
            getRedirectUrl: () => {
                if (capturedRedirectUrl === undefined) {
                    throw new Error('No redirect URL was captured. Ensure redirect() was called first.');
                }
                return capturedRedirectUrl;
            }
        } as unknown as Response & { getRedirectUrl: () => string };

        return mockResponse;
    };

    beforeEach(() => {
        provider = new DemoInMemoryAuthProvider();
        mockResponse = createMockResponse();
    });

    describe('authorize', () => {
        const validClient: OAuthClientInformationFull = {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['https://example.com/callback', 'https://example.com/callback2'],
            scope: 'test-scope'
        };

        it('should redirect to the requested redirect_uri when valid', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            await provider.authorize(validClient, params, mockResponse);

            expect(mockResponse.redirect).toHaveBeenCalled();
            expect(mockResponse.getRedirectUrl()).toBeDefined();

            const url = new URL(mockResponse.getRedirectUrl());
            expect(url.origin + url.pathname).toBe('https://example.com/callback');
            expect(url.searchParams.get('state')).toBe('test-state');
            expect(url.searchParams.has('code')).toBe(true);
        });

        it('should throw InvalidRequestError for unregistered redirect_uri', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://evil.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            await expect(provider.authorize(validClient, params, mockResponse)).rejects.toThrow(InvalidRequestError);

            await expect(provider.authorize(validClient, params, mockResponse)).rejects.toThrow('Unregistered redirect_uri');

            expect(mockResponse.redirect).not.toHaveBeenCalled();
        });

        it('should generate unique authorization codes for multiple requests', async () => {
            const params1: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'state-1',
                codeChallenge: 'challenge-1',
                scopes: ['test-scope']
            };

            const params2: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'state-2',
                codeChallenge: 'challenge-2',
                scopes: ['test-scope']
            };

            await provider.authorize(validClient, params1, mockResponse);
            const firstRedirectUrl = mockResponse.getRedirectUrl();
            const firstCode = new URL(firstRedirectUrl).searchParams.get('code');

            // Reset the mock for the second call
            mockResponse = createMockResponse();
            await provider.authorize(validClient, params2, mockResponse);
            const secondRedirectUrl = mockResponse.getRedirectUrl();
            const secondCode = new URL(secondRedirectUrl).searchParams.get('code');

            expect(firstCode).toBeDefined();
            expect(secondCode).toBeDefined();
            expect(firstCode).not.toBe(secondCode);
        });

        it('should handle params without state', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            await provider.authorize(validClient, params, mockResponse);

            expect(mockResponse.redirect).toHaveBeenCalled();
            expect(mockResponse.getRedirectUrl()).toBeDefined();

            const url = new URL(mockResponse.getRedirectUrl());
            expect(url.searchParams.has('state')).toBe(false);
            expect(url.searchParams.has('code')).toBe(true);
        });
    });

    describe('challengeForAuthorizationCode', () => {
        const validClient: OAuthClientInformationFull = {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['https://example.com/callback'],
            scope: 'test-scope'
        };

        it('should return the code challenge for a valid authorization code', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge-value',
                scopes: ['test-scope']
            };

            await provider.authorize(validClient, params, mockResponse);
            const code = new URL(mockResponse.getRedirectUrl()).searchParams.get('code')!;

            const challenge = await provider.challengeForAuthorizationCode(validClient, code);
            expect(challenge).toBe('test-challenge-value');
        });

        it('should throw error for invalid authorization code', async () => {
            await expect(provider.challengeForAuthorizationCode(validClient, 'invalid-code')).rejects.toThrow('Invalid authorization code');
        });
    });

    describe('exchangeAuthorizationCode', () => {
        const validClient: OAuthClientInformationFull = {
            client_id: 'test-client',
            client_secret: 'test-secret',
            redirect_uris: ['https://example.com/callback'],
            scope: 'test-scope'
        };

        it('should exchange valid authorization code for tokens', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope', 'other-scope']
            };

            await provider.authorize(validClient, params, mockResponse);
            const code = new URL(mockResponse.getRedirectUrl()).searchParams.get('code')!;

            const tokens = await provider.exchangeAuthorizationCode(validClient, code);

            expect(tokens).toEqual({
                access_token: expect.any(String),
                token_type: 'bearer',
                expires_in: 3600,
                scope: 'test-scope other-scope'
            });
        });

        it('should throw error for invalid authorization code', async () => {
            await expect(provider.exchangeAuthorizationCode(validClient, 'invalid-code')).rejects.toThrow('Invalid authorization code');
        });

        it('should throw error when client_id does not match', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            await provider.authorize(validClient, params, mockResponse);
            const code = new URL(mockResponse.getRedirectUrl()).searchParams.get('code')!;

            const differentClient: OAuthClientInformationFull = {
                client_id: 'different-client',
                client_secret: 'different-secret',
                redirect_uris: ['https://example.com/callback'],
                scope: 'test-scope'
            };

            await expect(provider.exchangeAuthorizationCode(differentClient, code)).rejects.toThrow(
                'Authorization code was not issued to this client'
            );
        });

        it('should delete authorization code after successful exchange', async () => {
            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope']
            };

            await provider.authorize(validClient, params, mockResponse);
            const code = new URL(mockResponse.getRedirectUrl()).searchParams.get('code')!;

            // First exchange should succeed
            await provider.exchangeAuthorizationCode(validClient, code);

            // Second exchange should fail
            await expect(provider.exchangeAuthorizationCode(validClient, code)).rejects.toThrow('Invalid authorization code');
        });

        it('should validate resource when validateResource is provided', async () => {
            const validateResource = jest.fn().mockReturnValue(false);
            const strictProvider = new DemoInMemoryAuthProvider(validateResource);

            const params: AuthorizationParams = {
                redirectUri: 'https://example.com/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
                scopes: ['test-scope'],
                resource: new URL('https://invalid-resource.com')
            };

            await strictProvider.authorize(validClient, params, mockResponse);
            const code = new URL(mockResponse.getRedirectUrl()).searchParams.get('code')!;

            await expect(strictProvider.exchangeAuthorizationCode(validClient, code)).rejects.toThrow(
                'Invalid resource: https://invalid-resource.com/'
            );

            expect(validateResource).toHaveBeenCalledWith(params.resource);
        });
    });

    describe('DemoInMemoryClientsStore', () => {
        let store: DemoInMemoryClientsStore;

        beforeEach(() => {
            store = new DemoInMemoryClientsStore();
        });

        it('should register and retrieve client', async () => {
            const client: OAuthClientInformationFull = {
                client_id: 'test-client',
                client_secret: 'test-secret',
                redirect_uris: ['https://example.com/callback'],
                scope: 'test-scope'
            };

            await store.registerClient(client);
            const retrieved = await store.getClient('test-client');

            expect(retrieved).toEqual(client);
        });

        it('should return undefined for non-existent client', async () => {
            const retrieved = await store.getClient('non-existent');
            expect(retrieved).toBeUndefined();
        });
    });
});
