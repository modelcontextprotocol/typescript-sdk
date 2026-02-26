import { createMockOAuthFetch } from '@modelcontextprotocol/test-helpers';
import { describe, expect, it, vi } from 'vitest';

import { auth } from '../../src/client/auth.js';
import {
    ClientCredentialsProvider,
    createPrivateKeyJwtAuth,
    CrossAppAccessProvider,
    PrivateKeyJwtProvider,
    StaticPrivateKeyJwtProvider
} from '../../src/client/authExtensions.js';

const RESOURCE_SERVER_URL = 'https://resource.example.com/';
const AUTH_SERVER_URL = 'https://auth.example.com';

describe('auth-extensions providers (end-to-end with auth())', () => {
    it('authenticates using ClientCredentialsProvider with client_secret_basic', async () => {
        const provider = new ClientCredentialsProvider({
            clientId: 'my-client',
            clientSecret: 'my-secret',
            clientName: 'test-client'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params).toBeInstanceOf(URLSearchParams);
                expect(params.get('grant_type')).toBe('client_credentials');
                expect(params.get('resource')).toBe(RESOURCE_SERVER_URL);
                expect(params.get('client_assertion')).toBeNull();

                const headers = new Headers(init?.headers);
                const authHeader = headers.get('Authorization');
                expect(authHeader).toBeTruthy();

                const expectedCredentials = Buffer.from('my-client:my-secret').toString('base64');
                expect(authHeader).toBe(`Basic ${expectedCredentials}`);
            }
        });

        const result = await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: fetchMock
        });

        expect(result).toBe('AUTHORIZED');
        const tokens = provider.tokens();
        expect(tokens).toBeTruthy();
        expect(tokens?.access_token).toBe('test-access-token');
    });

    it('authenticates using PrivateKeyJwtProvider with private_key_jwt', async () => {
        const provider = new PrivateKeyJwtProvider({
            clientId: 'client-id',
            privateKey: 'a-string-secret-at-least-256-bits-long',
            algorithm: 'HS256',
            clientName: 'private-key-jwt-client'
        });

        let assertionFromRequest: string | null = null;

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params).toBeInstanceOf(URLSearchParams);
                expect(params.get('grant_type')).toBe('client_credentials');
                expect(params.get('resource')).toBe(RESOURCE_SERVER_URL);

                assertionFromRequest = params.get('client_assertion');
                expect(assertionFromRequest).toBeTruthy();
                expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

                const parts = assertionFromRequest!.split('.');
                expect(parts).toHaveLength(3);

                const headers = new Headers(init?.headers);
                expect(headers.get('Authorization')).toBeNull();
            }
        });

        const result = await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: fetchMock
        });

        expect(result).toBe('AUTHORIZED');
        const tokens = provider.tokens();
        expect(tokens).toBeTruthy();
        expect(tokens?.access_token).toBe('test-access-token');
        expect(assertionFromRequest).toBeTruthy();
    });

    it('fails when PrivateKeyJwtProvider is configured with an unsupported algorithm', async () => {
        const provider = new PrivateKeyJwtProvider({
            clientId: 'client-id',
            privateKey: 'a-string-secret-at-least-256-bits-long',
            algorithm: 'none',
            clientName: 'private-key-jwt-client'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL
        });

        await expect(
            auth(provider, {
                serverUrl: RESOURCE_SERVER_URL,
                fetchFn: fetchMock
            })
        ).rejects.toThrow('Unsupported algorithm none');
    });

    it('authenticates using StaticPrivateKeyJwtProvider with static client assertion', async () => {
        const staticAssertion = 'header.payload.signature';

        const provider = new StaticPrivateKeyJwtProvider({
            clientId: 'static-client',
            jwtBearerAssertion: staticAssertion,
            clientName: 'static-private-key-jwt-client'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params).toBeInstanceOf(URLSearchParams);
                expect(params.get('grant_type')).toBe('client_credentials');
                expect(params.get('resource')).toBe(RESOURCE_SERVER_URL);

                expect(params.get('client_assertion')).toBe(staticAssertion);
                expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

                const headers = new Headers(init?.headers);
                expect(headers.get('Authorization')).toBeNull();
            }
        });

        const result = await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: fetchMock
        });

        expect(result).toBe('AUTHORIZED');
        const tokens = provider.tokens();
        expect(tokens).toBeTruthy();
        expect(tokens?.access_token).toBe('test-access-token');
    });
});

describe('createPrivateKeyJwtAuth', () => {
    const baseOptions = {
        issuer: 'client-id',
        subject: 'client-id',
        privateKey: 'a-string-secret-at-least-256-bits-long',
        alg: 'HS256'
    };

    it('creates an addClientAuthentication function that sets JWT assertion params', async () => {
        const addClientAuth = createPrivateKeyJwtAuth(baseOptions);

        const headers = new Headers();
        const params = new URLSearchParams();

        await addClientAuth(headers, params, 'https://auth.example.com/token', undefined);

        expect(params.get('client_assertion')).toBeTruthy();
        expect(params.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

        // Verify JWT structure (three dot-separated segments)
        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('throws when globalThis.crypto is not available', async () => {
        // Temporarily remove globalThis.crypto to simulate older Node.js runtimes
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const globalAny = globalThis as any;
        const originalCrypto = globalAny.crypto;
        // Use delete so that typeof globalThis.crypto === 'undefined'
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete globalAny.crypto;

        try {
            const addClientAuth = createPrivateKeyJwtAuth(baseOptions);
            const params = new URLSearchParams();

            await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
                'crypto is not available, please ensure you have Web Crypto API support for older Node.js versions'
            );
        } finally {
            // Restore original crypto to avoid affecting other tests
            globalAny.crypto = originalCrypto;
        }
    });

    it('creates a signed JWT when using a Uint8Array HMAC key', async () => {
        const secret = new TextEncoder().encode('a-string-secret-at-least-256-bits-long');

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: secret,
            alg: 'HS256'
        });

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined);

        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('creates a signed JWT when using a symmetric JWK key', async () => {
        const jwk: Record<string, unknown> = {
            kty: 'oct',
            // "a-string-secret-at-least-256-bits-long" base64url-encoded
            k: 'YS1zdHJpbmctc2VjcmV0LWF0LWxlYXN0LTI1Ni1iaXRzLWxvbmc',
            alg: 'HS256'
        };

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: jwk,
            alg: 'HS256'
        });

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined);

        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('creates a signed JWT when using an RSA PEM private key', async () => {
        // Generate an RSA key pair on the fly
        const jose = await import('jose');
        const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
        const pem = await jose.exportPKCS8(privateKey);

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: pem,
            alg: 'RS256'
        });

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined);

        const assertion = params.get('client_assertion')!;
        const parts = assertion.split('.');
        expect(parts).toHaveLength(3);
    });

    it('uses metadata.issuer as audience when available', async () => {
        const addClientAuth = createPrivateKeyJwtAuth(baseOptions);

        const params = new URLSearchParams();
        await addClientAuth(new Headers(), params, 'https://auth.example.com/token', {
            issuer: 'https://issuer.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        });

        const assertion = params.get('client_assertion')!;
        // Decode the payload to verify audience
        const [, payloadB64] = assertion.split('.');
        const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString());
        expect(payload.aud).toBe('https://issuer.example.com');
    });

    it('throws when using an unsupported algorithm', async () => {
        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: 'a-string-secret-at-least-256-bits-long',
            alg: 'none'
        });

        const params = new URLSearchParams();
        await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
            'Unsupported algorithm none'
        );
    });

    it('throws when jose cannot import an invalid RSA PEM key', async () => {
        const badPem = '-----BEGIN PRIVATE KEY-----\nnot-a-valid-key\n-----END PRIVATE KEY-----';

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: badPem,
            alg: 'RS256'
        });

        const params = new URLSearchParams();
        await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
            /Invalid character/
        );
    });

    it('throws when jose cannot import a mismatched JWK key', async () => {
        const jwk: Record<string, unknown> = {
            kty: 'oct',
            k: 'c2VjcmV0LWtleQ', // "secret-key" base64url
            alg: 'HS256'
        };

        const addClientAuth = createPrivateKeyJwtAuth({
            issuer: 'client-id',
            subject: 'client-id',
            privateKey: jwk,
            // Ask for an RSA algorithm with an octet key, which should cause jose.importJWK to fail
            alg: 'RS256'
        });

        const params = new URLSearchParams();
        await expect(addClientAuth(new Headers(), params, 'https://auth.example.com/token', undefined)).rejects.toThrow(
            /Key for the RS256 algorithm must be one of type CryptoKey, KeyObject, or JSON Web Key/
        );
    });
});

describe('CrossAppAccessProvider', () => {
    const RESOURCE_SERVER_URL = 'https://mcp.chat.example/';
    const AUTH_SERVER_URL = 'https://auth.chat.example';
    const IDP_URL = 'https://idp.example.com';

    it('successfully authenticates using Cross-App Access flow', async () => {
        let assertionCallbackInvoked = false;
        let jwtGrantUsed = '';

        const provider = new CrossAppAccessProvider({
            assertion: async ctx => {
                assertionCallbackInvoked = true;
                expect(ctx.authorizationServerUrl).toBe(AUTH_SERVER_URL);
                expect(ctx.resourceUrl).toBe(RESOURCE_SERVER_URL);
                expect(ctx.scope).toBeUndefined();
                expect(ctx.fetchFn).toBeDefined();
                return 'jwt-authorization-grant-token';
            },
            clientId: 'my-mcp-client',
            clientSecret: 'my-mcp-secret',
            clientName: 'xaa-test-client'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params).toBeInstanceOf(URLSearchParams);
                expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

                jwtGrantUsed = params.get('assertion') || '';
                expect(jwtGrantUsed).toBe('jwt-authorization-grant-token');

                // Verify client authentication
                const headers = new Headers(init?.headers);
                const authHeader = headers.get('Authorization');
                expect(authHeader).toBeTruthy();

                const expectedCredentials = Buffer.from('my-mcp-client:my-mcp-secret').toString('base64');
                expect(authHeader).toBe(`Basic ${expectedCredentials}`);
            }
        });

        const result = await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: fetchMock
        });

        expect(result).toBe('AUTHORIZED');
        expect(assertionCallbackInvoked).toBe(true);
        expect(jwtGrantUsed).toBe('jwt-authorization-grant-token');

        const tokens = provider.tokens();
        expect(tokens).toBeTruthy();
        expect(tokens?.access_token).toBe('test-access-token');
    });

    it('passes scope to assertion callback', async () => {
        let capturedScope: string | undefined;

        const provider = new CrossAppAccessProvider({
            assertion: async ctx => {
                capturedScope = ctx.scope;
                return 'jwt-grant';
            },
            clientId: 'client',
            clientSecret: 'secret'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL
        });

        await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            scope: 'chat.read chat.history',
            fetchFn: fetchMock
        });

        expect(capturedScope).toBe('chat.read chat.history');
    });

    it('passes custom fetchFn to assertion callback', async () => {
        let capturedFetchFn: unknown;

        const customFetch = vi.fn(fetch);
        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL
        });

        // Wrap the mock to track calls
        const wrappedFetch = vi.fn((...args: Parameters<typeof fetchMock>) => fetchMock(...args));

        const provider = new CrossAppAccessProvider({
            assertion: async ctx => {
                capturedFetchFn = ctx.fetchFn;
                return 'jwt-grant';
            },
            clientId: 'client',
            clientSecret: 'secret',
            fetchFn: customFetch
        });

        await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: wrappedFetch
        });

        // The assertion callback should receive the custom fetch function
        expect(capturedFetchFn).toBe(customFetch);
    });

    it('throws error when authorization server URL is not available', async () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        // Try to call prepareTokenRequest without going through auth()
        await expect(provider.prepareTokenRequest()).rejects.toThrow(
            'Authorization server URL not available. Ensure auth() has been called first.'
        );
    });

    it('throws error when resource URL is not available', async () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        // Manually set authorization server URL but not resource URL
        provider.saveAuthorizationServerUrl?.(AUTH_SERVER_URL);

        await expect(provider.prepareTokenRequest()).rejects.toThrow('Resource URL not available. Ensure auth() has been called first.');
    });

    it('stores and retrieves authorization server URL', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        expect(provider.authorizationServerUrl?.()).toBeUndefined();

        provider.saveAuthorizationServerUrl?.(AUTH_SERVER_URL);
        expect(provider.authorizationServerUrl?.()).toBe(AUTH_SERVER_URL);
    });

    it('stores and retrieves resource URL', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        expect(provider.resourceUrl?.()).toBeUndefined();

        provider.saveResourceUrl?.(RESOURCE_SERVER_URL);
        expect(provider.resourceUrl?.()).toBe(RESOURCE_SERVER_URL);
    });

    it('has correct client metadata', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret',
            clientName: 'custom-xaa-client'
        });

        const metadata = provider.clientMetadata;
        expect(metadata.client_name).toBe('custom-xaa-client');
        expect(metadata.redirect_uris).toEqual([]);
        expect(metadata.grant_types).toEqual(['urn:ietf:params:oauth:grant-type:jwt-bearer']);
        expect(metadata.token_endpoint_auth_method).toBe('client_secret_basic');
    });

    it('uses default client name when not provided', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        expect(provider.clientMetadata.client_name).toBe('cross-app-access-client');
    });

    it('returns undefined for redirectUrl (non-interactive flow)', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        expect(provider.redirectUrl).toBeUndefined();
    });

    it('throws error for redirectToAuthorization (not used in jwt-bearer)', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        expect(() => provider.redirectToAuthorization()).toThrow('redirectToAuthorization is not used for jwt-bearer flow');
    });

    it('throws error for codeVerifier (not used in jwt-bearer)', () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        expect(() => provider.codeVerifier()).toThrow('codeVerifier is not used for jwt-bearer flow');
    });

    it('handles assertion callback errors gracefully', async () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => {
                throw new Error('Failed to get ID token from IdP');
            },
            clientId: 'client',
            clientSecret: 'secret'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL
        });

        await expect(
            auth(provider, {
                serverUrl: RESOURCE_SERVER_URL,
                fetchFn: fetchMock
            })
        ).rejects.toThrow('Failed to get ID token from IdP');
    });

    it('allows assertion callback to return a promise', async () => {
        const provider = new CrossAppAccessProvider({
            assertion: ctx => {
                return new Promise(resolve => {
                    setTimeout(() => resolve('async-jwt-grant'), 10);
                });
            },
            clientId: 'client',
            clientSecret: 'secret'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params.get('assertion')).toBe('async-jwt-grant');
            }
        });

        const result = await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: fetchMock
        });

        expect(result).toBe('AUTHORIZED');
    });

    it('includes scope in token request params when provided', async () => {
        const provider = new CrossAppAccessProvider({
            assertion: async () => 'jwt-grant',
            clientId: 'client',
            clientSecret: 'secret'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params.get('scope')).toBe('chat.read chat.write');
            }
        });

        await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            scope: 'chat.read chat.write',
            fetchFn: fetchMock
        });
    });
});
