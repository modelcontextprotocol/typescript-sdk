import { InvalidGrantError, isTransientOAuthError, OAuthError, ServerError, TemporarilyUnavailableError } from '@modelcontextprotocol/core';
import { describe, expect, it, vi } from 'vitest';

import { parseErrorResponse, refreshAuthorization } from '../../src/client/auth.js';

describe('parseErrorResponse error-class compatibility', () => {
    it('returns the specific subclass for known OAuth error codes', async () => {
        const response = new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), {
            status: 400
        });
        const error = await parseErrorResponse(response);
        expect(error).toBeInstanceOf(InvalidGrantError);
        expect(error.code).toBe('invalid_grant');
        expect(isTransientOAuthError(error)).toBe(false);
    });

    it('preserves unknown error codes on the base class and classifies them transient', async () => {
        const response = new Response(JSON.stringify({ error: 'invalid_refresh_token', error_description: 'rotated' }), {
            status: 400
        });
        const error = await parseErrorResponse(response);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('invalid_refresh_token');
        expect(isTransientOAuthError(error)).toBe(true);
    });

    it('falls back to ServerError for unparsable bodies, matching 1.x', async () => {
        const response = new Response('<html>gateway timeout</html>', { status: 502 });
        const error = await parseErrorResponse(response);
        expect(error).toBeInstanceOf(ServerError);
        expect(isTransientOAuthError(error)).toBe(true);
    });
});

describe('refreshAuthorization error-class compatibility', () => {
    const metadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code']
    };
    const clientInformation = {
        client_id: 'client123',
        client_secret: 'secret123',
        redirect_uris: ['http://localhost:3000/callback']
    };

    function refreshWith(fetchFn: typeof fetch) {
        return refreshAuthorization('https://auth.example.com', {
            metadata,
            clientInformation,
            refreshToken: 'refresh123',
            fetchFn
        });
    }

    it('throws InvalidGrantError when the token endpoint rejects the refresh token', async () => {
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), { status: 400 })
        );
        const error = await refreshWith(fetchFn).catch(e => e);
        expect(error).toBeInstanceOf(InvalidGrantError);
        expect(error.code).toBe('invalid_grant');
        expect(isTransientOAuthError(error)).toBe(false);
    });

    it('preserves unknown token-endpoint error codes and classifies them transient', async () => {
        const fetchFn = vi.fn(
            async () => new Response(JSON.stringify({ error: 'invalid_refresh_token', error_description: 'rotated' }), { status: 400 })
        );
        const error = await refreshWith(fetchFn).catch(e => e);
        expect(error).toBeInstanceOf(OAuthError);
        expect(error.constructor).toBe(OAuthError);
        expect(error.code).toBe('invalid_refresh_token');
        expect(isTransientOAuthError(error)).toBe(true);
    });

    it('throws TemporarilyUnavailableError for a 503 with the matching code', async () => {
        const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }));
        const error = await refreshWith(fetchFn).catch(e => e);
        expect(error).toBeInstanceOf(TemporarilyUnavailableError);
        expect(isTransientOAuthError(error)).toBe(true);
    });
});
