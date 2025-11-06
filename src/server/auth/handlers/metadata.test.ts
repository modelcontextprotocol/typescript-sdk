import { metadataHandler } from './metadata.js';
import { OAuthMetadata } from '../../../shared/auth.js';
import express from 'express';
import supertest from 'supertest';

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

    let app: express.Express;

    beforeEach(() => {
        // Setup express app with metadata handler
        app = express();
        app.use('/.well-known/oauth-authorization-server', metadataHandler(exampleMetadata));
    });

    it('requires GET method', async () => {
        const response = await supertest(app).post('/.well-known/oauth-authorization-server').send({});

        expect(response.status).toBe(405);
        expect(response.headers.allow).toBe('GET, OPTIONS');
        expect(response.body).toEqual({
            error: 'method_not_allowed',
            error_description: 'The method POST is not allowed for this endpoint'
        });
    });

    it('returns the metadata object', async () => {
        const response = await supertest(app).get('/.well-known/oauth-authorization-server');

        expect(response.status).toBe(200);
        expect(response.body).toEqual(exampleMetadata);
    });

    it('includes CORS headers in response', async () => {
        const response = await supertest(app).get('/.well-known/oauth-authorization-server').set('Origin', 'https://example.com');

        expect(response.header['access-control-allow-origin']).toBe('*');
    });

    it('supports OPTIONS preflight requests', async () => {
        const response = await supertest(app)
            .options('/.well-known/oauth-authorization-server')
            .set('Origin', 'https://example.com')
            .set('Access-Control-Request-Method', 'GET');

        expect(response.status).toBe(204);
        expect(response.header['access-control-allow-origin']).toBe('*');
    });

    it('works with minimal metadata', async () => {
        // Setup a new express app with minimal metadata
        const minimalApp = express();
        const minimalMetadata: OAuthMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code']
        };
        minimalApp.use('/.well-known/oauth-authorization-server', metadataHandler(minimalMetadata));

        const response = await supertest(minimalApp).get('/.well-known/oauth-authorization-server');

        expect(response.status).toBe(200);
        expect(response.body).toEqual(minimalMetadata);
    });
});
