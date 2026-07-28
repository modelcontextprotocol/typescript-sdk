import { createMockOAuthFetch } from '@modelcontextprotocol/test-helpers';
import { describe, expect, it, vi } from 'vitest';

import { auth } from '../../src/client/auth';
import type { WorkloadAssertionContext, WorkloadIdentityProviderOptions } from '../../src/client/authExtensions';
import { WorkloadIdentityProvider } from '../../src/client/authExtensions';

const RESOURCE_SERVER_URL = 'https://mcp.example.com/';
const AUTH_SERVER_URL = 'https://auth.example.com';
const STATIC_ASSERTION = 'header.payload.signature';

function makeProvider(overrides: Partial<WorkloadIdentityProviderOptions> = {}): WorkloadIdentityProvider {
    const provider = new WorkloadIdentityProvider({
        clientId: 'wif-client',
        assertion: STATIC_ASSERTION,
        ...overrides
    });

    // The auth() flow normally calls these after RFC 9728 discovery
    provider.saveAuthorizationServerUrl(AUTH_SERVER_URL);
    provider.saveResourceUrl?.(RESOURCE_SERVER_URL);
    return provider;
}

describe('WorkloadIdentityProvider token request', () => {
    it('sends the jwt-bearer grant with a static assertion', async () => {
        const params = await makeProvider().prepareTokenRequest();

        expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(params.get('assertion')).toBe(STATIC_ASSERTION);
        expect(params.get('scope')).toBeNull();
    });

    it('does not set the resource parameter (auth() sets it after the provider returns)', async () => {
        const params = await makeProvider().prepareTokenRequest();

        expect(params.get('resource')).toBeNull();
    });

    it('resolves a static assertion without discovery state', async () => {
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: STATIC_ASSERTION
        });

        const params = await provider.prepareTokenRequest();

        expect(params.get('assertion')).toBe(STATIC_ASSERTION);
    });

    it('uses the framework-supplied scope argument', async () => {
        const params = await makeProvider().prepareTokenRequest('challenge.scope');

        expect(params.get('scope')).toBe('challenge.scope');
    });

    it('prefers the framework-supplied scope over the configured scope', async () => {
        const params = await makeProvider({ scope: 'configured' }).prepareTokenRequest('challenge.scope');

        expect(params.get('scope')).toBe('challenge.scope');
    });

    it('exposes the configured scope through clientMetadata instead of setting it directly', async () => {
        const provider = makeProvider({ scope: 'configured' });

        expect(provider.clientMetadata.scope).toBe('configured');

        // fetchToken falls back to clientMetadata.scope when auth() resolves no scope,
        // so prepareTokenRequest itself only uses its argument
        const params = await provider.prepareTokenRequest();
        expect(params.get('scope')).toBeNull();
    });

    it('invokes the assertion callback with the discovered context', async () => {
        let seenContext: WorkloadAssertionContext | undefined;

        const provider = makeProvider({
            assertion: async context => {
                seenContext = context;
                return 'callback.jwt.value';
            }
        });

        const params = await provider.prepareTokenRequest('requested.scope');

        expect(params.get('assertion')).toBe('callback.jwt.value');
        expect(seenContext).toMatchObject({
            authorizationServerUrl: AUTH_SERVER_URL,
            resourceUrl: RESOURCE_SERVER_URL,
            scope: 'requested.scope'
        });
        expect(seenContext?.fetchFn).toBeDefined();
    });

    it('passes a custom fetchFn to the assertion callback', async () => {
        const customFetch = vi.fn(fetch);
        let capturedFetchFn: unknown;

        const provider = makeProvider({
            assertion: async context => {
                capturedFetchFn = context.fetchFn;
                return 'callback.jwt.value';
            },
            fetchFn: customFetch
        });

        await provider.prepareTokenRequest();

        expect(capturedFetchFn).toBe(customFetch);
    });

    it('passes undefined resourceUrl to the callback when none was discovered', async () => {
        let seenContext: WorkloadAssertionContext | undefined;

        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: async context => {
                seenContext = context;
                return 'callback.jwt.value';
            }
        });
        provider.saveAuthorizationServerUrl(AUTH_SERVER_URL);

        await provider.prepareTokenRequest();

        expect(seenContext).toBeDefined();
        expect(seenContext?.resourceUrl).toBeUndefined();
    });

    it('throws when the assertion callback needs an authorization server URL that is not available', async () => {
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: async () => 'callback.jwt.value'
        });

        await expect(provider.prepareTokenRequest()).rejects.toThrow(
            'Authorization server URL not available. Ensure auth() has been called first.'
        );
    });
});

describe('WorkloadIdentityProvider non-interactive contract', () => {
    it('returns undefined for redirectUrl', () => {
        expect(makeProvider().redirectUrl).toBeUndefined();
    });

    it('throws a descriptive error from redirectToAuthorization', () => {
        expect(() => makeProvider().redirectToAuthorization()).toThrow(/non-interactive/);
        expect(() => makeProvider().redirectToAuthorization()).toThrow(/jwt-bearer/);
        expect(() => makeProvider().redirectToAuthorization()).toThrow(/workload issuer/);
    });

    it('throws from codeVerifier (PKCE is not used)', () => {
        expect(() => makeProvider().codeVerifier()).toThrow('codeVerifier is not used for jwt-bearer flow');
    });

    it('throws from saveCodeVerifier (PKCE is not used)', () => {
        expect(() => makeProvider().saveCodeVerifier()).toThrow('saveCodeVerifier is not used for jwt-bearer flow');
    });
});

describe('WorkloadIdentityProvider client information and state', () => {
    it('returns the configured client_id', () => {
        expect(makeProvider().clientInformation()).toMatchObject({ client_id: 'wif-client' });
    });

    it('stamps expectedIssuer onto the stored client information (SEP-2352)', () => {
        const provider = makeProvider({ expectedIssuer: AUTH_SERVER_URL });

        expect(provider.clientInformation()).toMatchObject({
            client_id: 'wif-client',
            issuer: AUTH_SERVER_URL
        });
    });

    it('has correct client metadata', () => {
        const metadata = makeProvider().clientMetadata;

        expect(metadata.client_name).toBe('workload-identity-client');
        expect(metadata.redirect_uris).toEqual([]);
        expect(metadata.grant_types).toEqual(['urn:ietf:params:oauth:grant-type:jwt-bearer']);
        expect(metadata.token_endpoint_auth_method).toBe('none');
    });

    it('uses a custom client name when provided', () => {
        expect(makeProvider({ clientName: 'custom-wif-client' }).clientMetadata.client_name).toBe('custom-wif-client');
    });

    it('stores and retrieves tokens in memory', () => {
        const provider = makeProvider();

        expect(provider.tokens()).toBeUndefined();

        provider.saveTokens({ access_token: 'stored-token', token_type: 'Bearer' });
        expect(provider.tokens()?.access_token).toBe('stored-token');
    });

    it('stores and retrieves authorization server URL', () => {
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: STATIC_ASSERTION
        });

        expect(provider.authorizationServerUrl?.()).toBeUndefined();

        provider.saveAuthorizationServerUrl(AUTH_SERVER_URL);
        expect(provider.authorizationServerUrl?.()).toBe(AUTH_SERVER_URL);
    });

    it('stores and retrieves resource URL', () => {
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: STATIC_ASSERTION
        });

        expect(provider.resourceUrl?.()).toBeUndefined();

        provider.saveResourceUrl?.(RESOURCE_SERVER_URL);
        expect(provider.resourceUrl?.()).toBe(RESOURCE_SERVER_URL);
    });
});

describe('WorkloadIdentityProvider rejection memory', () => {
    it('refuses to re-present the same assertion after an unconfirmed attempt', async () => {
        const provider = makeProvider();

        await provider.prepareTokenRequest();

        await expect(provider.prepareTokenRequest()).rejects.toThrow(/rejected|same credential|wif-no-retry/i);
    });

    it('allows a new request after saveTokens confirmed the previous one', async () => {
        const provider = makeProvider();

        await provider.prepareTokenRequest();
        provider.saveTokens({ access_token: 'granted-token', token_type: 'Bearer' });

        await expect(provider.prepareTokenRequest()).resolves.toBeDefined();
    });

    it('allows a retry when the callback supplies a fresh assertion', async () => {
        let counter = 0;
        const provider = makeProvider({ assertion: () => `jwt.${counter++}` });

        await provider.prepareTokenRequest();

        const params = await provider.prepareTokenRequest();
        expect(params.get('assertion')).toBe('jwt.1');
    });

    it('reuses a static assertion across separately confirmed auth cycles', async () => {
        const provider = makeProvider();

        for (let cycle = 0; cycle < 2; cycle++) {
            const params = await provider.prepareTokenRequest();
            expect(params.get('assertion')).toBe(STATIC_ASSERTION);
            provider.saveTokens({ access_token: `token-${cycle}`, token_type: 'Bearer' });
        }

        await expect(provider.prepareTokenRequest()).resolves.toBeDefined();
    });
});

describe('WorkloadIdentityProvider (end-to-end with auth())', () => {
    it('successfully authenticates using the jwt-bearer flow', async () => {
        let assertionCallbackInvoked = false;
        let assertionUsed = '';

        const provider = new WorkloadIdentityProvider({
            assertion: async context => {
                assertionCallbackInvoked = true;
                expect(context.authorizationServerUrl).toBe(AUTH_SERVER_URL);
                expect(context.resourceUrl).toBe(RESOURCE_SERVER_URL);
                expect(context.scope).toBeUndefined();
                expect(context.fetchFn).toBeDefined();
                return 'workload.jwt.assertion';
            },
            clientId: 'wif-client',
            clientName: 'wif-test-client'
        });

        const fetchMock = createMockOAuthFetch({
            resourceServerUrl: RESOURCE_SERVER_URL,
            authServerUrl: AUTH_SERVER_URL,
            onTokenRequest: async (_url, init) => {
                const params = init?.body as URLSearchParams;
                expect(params).toBeInstanceOf(URLSearchParams);
                expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

                assertionUsed = params.get('assertion') || '';
                expect(assertionUsed).toBe('workload.jwt.assertion');

                expect(params.get('resource')).toBe(RESOURCE_SERVER_URL);

                // Public client: client_id travels in the body, no Authorization header
                expect(params.get('client_id')).toBe('wif-client');
                const headers = new Headers(init?.headers);
                expect(headers.get('Authorization')).toBeNull();
            }
        });

        const result = await auth(provider, {
            serverUrl: RESOURCE_SERVER_URL,
            fetchFn: fetchMock
        });

        expect(result).toBe('AUTHORIZED');
        expect(assertionCallbackInvoked).toBe(true);
        expect(assertionUsed).toBe('workload.jwt.assertion');

        const tokens = provider.tokens();
        expect(tokens).toBeTruthy();
        expect(tokens?.access_token).toBe('test-access-token');
    });
});
