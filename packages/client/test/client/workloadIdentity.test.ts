import type { FetchLike } from '@modelcontextprotocol/core-internal';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';
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

/**
 * Hand-rolled fetch mock in the auth.test.ts style: createMockOAuthFetch cannot
 * serve error responses or count calls, so the failure-path tests script the
 * token endpoint themselves and log every token request body.
 */
function createFailingOAuthFetch(tokenErrorCode: string): { fetchMock: FetchLike; tokenRequestBodies: URLSearchParams[] } {
    const tokenRequestBodies: URLSearchParams[] = [];

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof URL ? input : new URL(input);

        if (url.origin === RESOURCE_SERVER_URL.slice(0, -1) && url.pathname === '/.well-known/oauth-protected-resource') {
            return Response.json({
                resource: RESOURCE_SERVER_URL,
                authorization_servers: [AUTH_SERVER_URL]
            });
        }

        if (url.origin === AUTH_SERVER_URL && url.pathname === '/.well-known/oauth-authorization-server') {
            return Response.json({
                issuer: AUTH_SERVER_URL,
                authorization_endpoint: `${AUTH_SERVER_URL}/authorize`,
                token_endpoint: `${AUTH_SERVER_URL}/token`,
                response_types_supported: ['code'],
                grant_types_supported: ['urn:ietf:params:oauth:grant-type:jwt-bearer'],
                token_endpoint_auth_methods_supported: ['none']
            });
        }

        if (url.origin === AUTH_SERVER_URL && url.pathname === '/token') {
            tokenRequestBodies.push(new URLSearchParams(init?.body as URLSearchParams));
            return Response.json({ error: tokenErrorCode }, { status: 400 });
        }

        throw new Error(`Unexpected URL in scripted OAuth fetch: ${url.toString()}`);
    });

    return { fetchMock, tokenRequestBodies };
}

describe('WorkloadIdentityProvider failure paths through auth()', () => {
    it('invalid_grant with a static assertion: replay refusal surfaces, exactly one token request', async () => {
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: STATIC_ASSERTION
        });
        const { fetchMock, tokenRequestBodies } = createFailingOAuthFetch('invalid_grant');

        // auth() invalidates tokens on invalid_grant and re-runs authInternal once;
        // the provider refuses to replay the identical rejected assertion on that
        // re-run, so the rejection carries the wif-no-retry refusal.
        await expect(auth(provider, { serverUrl: RESOURCE_SERVER_URL, fetchFn: fetchMock })).rejects.toThrow(/wif-no-retry/);

        expect(tokenRequestBodies).toHaveLength(1);
        expect(tokenRequestBodies[0]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(tokenRequestBodies[0]!.get('assertion')).toBe(STATIC_ASSERTION);
    });

    it('invalid_grant with a fresh-assertion callback: re-run allowed, error still surfaces after exactly two jwt-bearer requests', async () => {
        let counter = 0;
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: () => `workload.jwt.${counter++}`
        });
        const { fetchMock, tokenRequestBodies } = createFailingOAuthFetch('invalid_grant');

        const rejection = await auth(provider, { serverUrl: RESOURCE_SERVER_URL, fetchFn: fetchMock }).then(
            () => undefined,
            error => error
        );

        expect(rejection).toBeInstanceOf(OAuthError);
        expect((rejection as OAuthError).code).toBe(OAuthErrorCode.InvalidGrant);

        expect(tokenRequestBodies).toHaveLength(2);
        expect(tokenRequestBodies[0]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(tokenRequestBodies[1]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(tokenRequestBodies[0]!.get('assertion')).toBe('workload.jwt.0');
        expect(tokenRequestBodies[1]!.get('assertion')).toBe('workload.jwt.1');
        expect(tokenRequestBodies.filter(body => body.get('grant_type') === 'authorization_code')).toHaveLength(0);
    });

    it('invalid_scope surfaces without retry, grant fallback, or redirect', async () => {
        const provider = new WorkloadIdentityProvider({
            clientId: 'wif-client',
            assertion: STATIC_ASSERTION
        });
        const redirectSpy = vi.spyOn(provider, 'redirectToAuthorization');
        const { fetchMock, tokenRequestBodies } = createFailingOAuthFetch('invalid_scope');

        const rejection = await auth(provider, { serverUrl: RESOURCE_SERVER_URL, fetchFn: fetchMock }).then(
            () => undefined,
            error => error
        );

        expect(rejection).toBeInstanceOf(OAuthError);
        expect((rejection as OAuthError).code).toBe(OAuthErrorCode.InvalidScope);

        // invalid_scope is outside auth()'s recoverable set, so authInternal runs once
        expect(tokenRequestBodies).toHaveLength(1);
        expect(tokenRequestBodies[0]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
        expect(tokenRequestBodies.filter(body => body.get('grant_type') === 'authorization_code')).toHaveLength(0);
        expect(redirectSpy).not.toHaveBeenCalled();
    });
});
