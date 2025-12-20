import type { OAuthMetadata } from '@modelcontextprotocol/core';

import { metadataHandler } from '../../../../src/server/auth/handlers/metadata.js';

describe('Metadata Handler', () => {
    const exampleMetadata: OAuthMetadata = {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        revocation_endpoint: 'https://auth.example.com/revoke',
        scopes_supported: ['profile', 'email'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256']
    };

    it('requires GET method', async () => {
        const handler = metadataHandler(exampleMetadata);
        const res = await handler(new Request('http://localhost/.well-known/oauth-authorization-server', { method: 'POST' }));

        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, OPTIONS');
        expect(await res.json()).toEqual({
            error: 'method_not_allowed',
            error_description: 'The method POST is not allowed for this endpoint'
        });
    });

    it('returns the metadata object', async () => {
        const handler = metadataHandler(exampleMetadata);
        const res = await handler(new Request('http://localhost/.well-known/oauth-authorization-server', { method: 'GET' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(exampleMetadata);
    });

    it('includes CORS headers in response', async () => {
        const handler = metadataHandler(exampleMetadata);
        const res = await handler(
            new Request('http://localhost/.well-known/oauth-authorization-server', {
                method: 'GET',
                headers: { Origin: 'https://example.com' }
            })
        );

        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('supports OPTIONS preflight requests', async () => {
        const handler = metadataHandler(exampleMetadata);
        const res = await handler(
            new Request('http://localhost/.well-known/oauth-authorization-server', {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://example.com',
                    'Access-Control-Request-Method': 'GET'
                }
            })
        );

        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('works with minimal metadata', async () => {
        const minimalMetadata: OAuthMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };
        const handler = metadataHandler(minimalMetadata);
        const res = await handler(new Request('http://localhost/.well-known/oauth-authorization-server', { method: 'GET' }));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(minimalMetadata);
    });
});
