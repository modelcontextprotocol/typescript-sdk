import type { FetchLike } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import {
    discoverAndRequestJwtAuthGrant,
    exchangeJwtAuthGrant,
    requestJwtAuthorizationGrant
} from '../../src/client/crossAppAccess.js';

describe('crossAppAccess', () => {
    describe('requestJwtAuthorizationGrant', () => {
        it('successfully exchanges ID token for JWT Authorization Grant', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                    token_type: 'N_A',
                    expires_in: 300,
                    scope: 'chat.read chat.history'
                })
            } as Response);

            const result = await requestJwtAuthorizationGrant({
                tokenEndpoint: 'https://idp.example.com/token',
                audience: 'https://auth.chat.example/',
                resource: 'https://mcp.chat.example/',
                idToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
                clientId: 'my-idp-client',
                clientSecret: 'my-idp-secret',
                scope: 'chat.read chat.history',
                fetchFn: mockFetch
            });

            expect(result.jwtAuthGrant).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
            expect(result.expiresIn).toBe(300);
            expect(result.scope).toBe('chat.read chat.history');

            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, init] = mockFetch.mock.calls[0]!;
            expect(url).toBe('https://idp.example.com/token');
            expect(init?.method).toBe('POST');
            expect(init?.headers).toEqual({
                'Content-Type': 'application/x-www-form-urlencoded'
            });

            const body = new URLSearchParams(init?.body as string);
            expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
            expect(body.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:id-jag');
            expect(body.get('audience')).toBe('https://auth.chat.example/');
            expect(body.get('resource')).toBe('https://mcp.chat.example/');
            expect(body.get('subject_token')).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...');
            expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
            expect(body.get('client_id')).toBe('my-idp-client');
            expect(body.get('client_secret')).toBe('my-idp-secret');
            expect(body.get('scope')).toBe('chat.read chat.history');
        });

        it('works without optional scope parameter', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                    access_token: 'jag-token',
                    token_type: 'N_A'
                })
            } as Response);

            const result = await requestJwtAuthorizationGrant({
                tokenEndpoint: 'https://idp.example.com/token',
                audience: 'https://auth.chat.example/',
                resource: 'https://mcp.chat.example/',
                idToken: 'id-token',
                clientId: 'client',
                clientSecret: 'secret',
                fetchFn: mockFetch
            });

            expect(result.jwtAuthGrant).toBe('jag-token');

            const body = new URLSearchParams(mockFetch.mock.calls[0]![1]?.body as string);
            expect(body.get('scope')).toBeNull();
        });

        it('throws error when issued_token_type is incorrect', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
                    access_token: 'token',
                    token_type: 'N_A'
                })
            } as Response);

            await expect(
                requestJwtAuthorizationGrant({
                    tokenEndpoint: 'https://idp.example.com/token',
                    audience: 'https://auth.chat.example/',
                    resource: 'https://mcp.chat.example/',
                    idToken: 'id-token',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow("Invalid issued_token_type: expected 'urn:ietf:params:oauth:token-type:id-jag'");
        });

        it('throws error when token_type is incorrect', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                    access_token: 'token',
                    token_type: 'Bearer'
                })
            } as Response);

            await expect(
                requestJwtAuthorizationGrant({
                    tokenEndpoint: 'https://idp.example.com/token',
                    audience: 'https://auth.chat.example/',
                    resource: 'https://mcp.chat.example/',
                    idToken: 'id-token',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow("Invalid token_type: expected 'N_A'");
        });

        it('throws error when access_token is missing', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                    token_type: 'N_A'
                })
            } as Response);

            await expect(
                requestJwtAuthorizationGrant({
                    tokenEndpoint: 'https://idp.example.com/token',
                    audience: 'https://auth.chat.example/',
                    resource: 'https://mcp.chat.example/',
                    idToken: 'id-token',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow('Missing or invalid access_token in token exchange response');
        });

        it('handles OAuth error responses', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({
                    error: 'invalid_grant',
                    error_description: 'Audience validation failed'
                })
            } as Response);

            await expect(
                requestJwtAuthorizationGrant({
                    tokenEndpoint: 'https://idp.example.com/token',
                    audience: 'https://auth.chat.example/',
                    resource: 'https://mcp.chat.example/',
                    idToken: 'id-token',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow('Token exchange failed: invalid_grant - Audience validation failed');
        });

        it('handles non-OAuth error responses', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({ message: 'Internal server error' })
            } as Response);

            await expect(
                requestJwtAuthorizationGrant({
                    tokenEndpoint: 'https://idp.example.com/token',
                    audience: 'https://auth.chat.example/',
                    resource: 'https://mcp.chat.example/',
                    idToken: 'id-token',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow('Token exchange failed with status 500');
        });
    });

    describe('discoverAndRequestJwtAuthGrant', () => {
        it('discovers token endpoint and performs token exchange', async () => {
            const mockFetch = vi.fn<FetchLike>();

            // Mock discovery response
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    issuer: 'https://idp.example.com',
                    authorization_endpoint: 'https://idp.example.com/authorize',
                    token_endpoint: 'https://idp.example.com/token',
                    jwks_uri: 'https://idp.example.com/jwks',
                    response_types_supported: ['code'],
                    grant_types_supported: ['urn:ietf:params:oauth:grant-type:token-exchange']
                })
            } as Response);

            // Mock token exchange response
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
                    access_token: 'jag-token',
                    token_type: 'N_A',
                    expires_in: 300
                })
            } as Response);

            const result = await discoverAndRequestJwtAuthGrant({
                idpUrl: 'https://idp.example.com',
                audience: 'https://auth.chat.example/',
                resource: 'https://mcp.chat.example/',
                idToken: 'id-token',
                clientId: 'client',
                clientSecret: 'secret',
                fetchFn: mockFetch
            });

            expect(result.jwtAuthGrant).toBe('jag-token');
            expect(result.expiresIn).toBe(300);

            expect(mockFetch).toHaveBeenCalledTimes(2);
            // First call is discovery
            expect(String(mockFetch.mock.calls[0]![0])).toContain('.well-known/oauth-authorization-server');
            // Second call is token exchange
            expect(String(mockFetch.mock.calls[1]![0])).toBe('https://idp.example.com/token');
        });

        it('throws error when token endpoint is not discovered', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    issuer: 'https://idp.example.com',
                    authorization_endpoint: 'https://idp.example.com/authorize'
                    // Missing token_endpoint and response_types_supported
                })
            } as Response);

            await expect(
                discoverAndRequestJwtAuthGrant({
                    idpUrl: 'https://idp.example.com',
                    audience: 'https://auth.chat.example/',
                    resource: 'https://mcp.chat.example/',
                    idToken: 'id-token',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow(); // Zod validation error
        });
    });

    describe('exchangeJwtAuthGrant', () => {
        it('successfully exchanges JWT Authorization Grant for access token', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    access_token: 'mcp-access-token',
                    token_type: 'Bearer',
                    expires_in: 3600,
                    scope: 'chat.read chat.history'
                })
            } as Response);

            const result = await exchangeJwtAuthGrant({
                tokenEndpoint: 'https://auth.chat.example/token',
                jwtAuthGrant: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                clientId: 'my-mcp-client',
                clientSecret: 'my-mcp-secret',
                fetchFn: mockFetch
            });

            expect(result.access_token).toBe('mcp-access-token');
            expect(result.token_type).toBe('Bearer');
            expect(result.expires_in).toBe(3600);
            expect(result.scope).toBe('chat.read chat.history');

            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, init] = mockFetch.mock.calls[0]!;
            expect(url).toBe('https://auth.chat.example/token');
            expect(init?.method).toBe('POST');

            const body = new URLSearchParams(init?.body as string);
            expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
            expect(body.get('assertion')).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
            expect(body.get('client_id')).toBe('my-mcp-client');
            expect(body.get('client_secret')).toBe('my-mcp-secret');
        });

        it('handles OAuth error responses', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: false,
                status: 400,
                json: async () => ({
                    error: 'invalid_grant',
                    error_description: 'JWT signature verification failed'
                })
            } as Response);

            await expect(
                exchangeJwtAuthGrant({
                    tokenEndpoint: 'https://auth.chat.example/token',
                    jwtAuthGrant: 'invalid-jwt',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow('JWT grant exchange failed: invalid_grant - JWT signature verification failed');
        });

        it('validates token response with schema', async () => {
            const mockFetch = vi.fn<FetchLike>().mockResolvedValue({
                ok: true,
                json: async () => ({
                    // Missing required fields
                    token_type: 'Bearer'
                })
            } as Response);

            await expect(
                exchangeJwtAuthGrant({
                    tokenEndpoint: 'https://auth.chat.example/token',
                    jwtAuthGrant: 'jwt',
                    clientId: 'client',
                    clientSecret: 'secret',
                    fetchFn: mockFetch
                })
            ).rejects.toThrow('Invalid token response');
        });
    });
});
