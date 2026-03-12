/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1342
 *
 * Some OAuth servers (e.g., GitHub) return error responses with HTTP 200 status
 * instead of 4xx. Previously, the SDK would try to parse these as tokens and fail
 * with a confusing Zod validation error. This test verifies that the SDK properly
 * detects the error field and surfaces the actual OAuth error message.
 */

import { exchangeAuthorization } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Issue #1342: OAuth error response with HTTP 200 status', () => {
    const validClientInfo = {
        client_id: 'test-client',
        client_secret: 'test-secret',
        redirect_uris: ['http://localhost:3000/callback'],
        token_endpoint_auth_method: 'client_secret_post' as const
    };

    it('should throw OAuth error when server returns error with HTTP 200', async () => {
        // GitHub returns errors with HTTP 200 instead of 4xx
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                error: 'invalid_client',
                error_description: 'The client_id and/or client_secret passed are incorrect.'
            })
        });

        await expect(
            exchangeAuthorization('https://auth.example.com', {
                clientInformation: validClientInfo,
                authorizationCode: 'code123',
                codeVerifier: 'verifier123',
                redirectUri: 'http://localhost:3000/callback'
            })
        ).rejects.toThrow('The client_id and/or client_secret passed are incorrect.');
    });
});
