import type { FetchLike } from '@modelcontextprotocol/core';
import { vi } from 'vitest';

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
            return Response.json(
                {
                    resource: resourceServerUrl,
                    authorization_servers: [authServerUrl]
                },
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // Authorization server metadata discovery
        if (url.origin === authServerUrl && url.pathname === '/.well-known/oauth-authorization-server') {
            return Response.json(
                {
                    issuer: authServerUrl,
                    authorization_endpoint: `${authServerUrl}/authorize`,
                    token_endpoint: `${authServerUrl}/token`,
                    response_types_supported: ['code'],
                    token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt']
                },
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

            return Response.json(
                {
                    access_token: 'test-access-token',
                    token_type: 'Bearer'
                },
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        throw new Error(`Unexpected URL in mock OAuth fetch: ${url.toString()}`);
    };
}

type MockFetch = (...args: unknown[]) => unknown;

/**
 * Helper to install a vi.fn-based global.fetch mock for tests that rely on global fetch.
 */
export function mockGlobalFetch(): MockFetch {
    const mockFetch = vi.fn() as unknown as MockFetch;
    (globalThis as { fetch?: MockFetch }).fetch = mockFetch;
    return mockFetch;
}
