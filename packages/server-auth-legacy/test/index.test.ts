import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
    type AuthInfo,
    type AuthRouterOptions,
    InvalidTokenError,
    mcpAuthRouter,
    OAuthError,
    type OAuthRegisteredClientsStore,
    type OAuthServerProvider,
    ProxyOAuthServerProvider,
    ServerError
} from '../src/index.js';

describe('@modelcontextprotocol/server-auth-legacy (frozen v1 compat)', () => {
    it('exports the v1 OAuthError subclass hierarchy', () => {
        const err = new InvalidTokenError('bad token');
        expect(err).toBeInstanceOf(OAuthError);
        expect(err.errorCode).toBe('invalid_token');
        expect(err.toResponseObject()).toEqual({
            error: 'invalid_token',
            error_description: 'bad token'
        });
    });

    it('exports ProxyOAuthServerProvider', () => {
        const provider = new ProxyOAuthServerProvider({
            endpoints: {
                authorizationUrl: 'https://upstream.example/authorize',
                tokenUrl: 'https://upstream.example/token'
            },
            verifyAccessToken: async token => ({ token, clientId: 'c', scopes: [] }) satisfies AuthInfo,
            getClient: async () => undefined
        });
        expect(provider.skipLocalPkceValidation).toBe(true);
        expect(provider.clientsStore.getClient).toBeTypeOf('function');
    });

    it('mcpAuthRouter wires up /authorize, /token and AS metadata', async () => {
        const clientsStore: OAuthRegisteredClientsStore = {
            getClient: () => undefined
        };
        const provider: OAuthServerProvider = {
            clientsStore,
            authorize: async () => {
                throw new ServerError('not implemented');
            },
            challengeForAuthorizationCode: async () => 'challenge',
            exchangeAuthorizationCode: async () => ({ access_token: 't', token_type: 'Bearer' }),
            exchangeRefreshToken: async () => ({ access_token: 't', token_type: 'Bearer' }),
            verifyAccessToken: async token => ({ token, clientId: 'c', scopes: [] })
        };

        const options: AuthRouterOptions = {
            provider,
            issuerUrl: new URL('http://localhost/')
        };

        const app = express();
        app.use(mcpAuthRouter(options));

        const res = await request(app).get('/.well-known/oauth-authorization-server');
        expect(res.status).toBe(200);
        expect(res.body.issuer).toBe('http://localhost/');
        expect(res.body.authorization_endpoint).toBe('http://localhost/authorize');
        expect(res.body.token_endpoint).toBe('http://localhost/token');
    });
});
