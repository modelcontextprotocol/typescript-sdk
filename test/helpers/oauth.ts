import type { FetchLike } from '../../src/shared/transport.js';

export interface MockOAuthFetchOptions {
    resourceServerUrl: string;
    authServerUrl: string;
    /**
     * Optional hook to inspect or override the token request.
     */
    onTokenRequest?: (url: URL, init: RequestInit | undefined) => void | Promise<void>;
}

/**
 * Shared mock fetch implementation for OAuth flows used in client tests.
 *
 * It handles:
 * - OAuth Protected Resource Metadata discovery
 * - Authorization Server Metadata discovery
 * - Token endpoint responses
 */
export function createMockOAuthFetch(options: MockOAuthFetchOptions): FetchLike {
    const { resourceServerUrl, authServerUrl, onTokenRequest } = options;

    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const url = input instanceof URL ? input : new URL(input);

        // Protected resource metadata discovery
        if (url.origin === resourceServerUrl.slice(0, -1) && url.pathname === '/.well-known/oauth-protected-resource') {
            return new Response(
                JSON.stringify({
                    resource: resourceServerUrl,
                    authorization_servers: [authServerUrl]
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // Authorization server metadata discovery
        if (url.origin === authServerUrl && url.pathname === '/.well-known/oauth-authorization-server') {
            return new Response(
                JSON.stringify({
                    issuer: authServerUrl,
                    authorization_endpoint: `${authServerUrl}/authorize`,
                    token_endpoint: `${authServerUrl}/token`,
                    response_types_supported: ['code'],
                    token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt']
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // Token endpoint
        if (url.origin === authServerUrl && url.pathname === '/token') {
            if (onTokenRequest) {
                await onTokenRequest(url, init);
            }

            return new Response(
                JSON.stringify({
                    access_token: 'test-access-token',
                    token_type: 'Bearer'
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        throw new Error(`Unexpected URL in mock OAuth fetch: ${url.toString()}`);
    };
}

/**
 * Helper to install a vi.fn-based global.fetch mock for tests that rely on global fetch.
 */
export function mockGlobalFetch() {
    const mockFetch = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = mockFetch;
    return mockFetch;
}
