import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import express from 'express';
import supertest from 'supertest';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type { OAuthTokenVerifier } from '../../src/auth/types.js';
import { requireBearerAuth } from '../../src/auth/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from '../../src/auth/metadataRouter.js';

// ---------------------------------------------------------------------------
// requireBearerAuth
// ---------------------------------------------------------------------------

const mockVerifyAccessToken = vi.fn();
const mockVerifier: OAuthTokenVerifier = { verifyAccessToken: mockVerifyAccessToken };

function createMockReqResNext(authorization?: string) {
    const req = { headers: { authorization } } as Request;
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis()
    } as unknown as Response;
    const next = vi.fn() as Mock;
    return { req, res, next };
}

describe('requireBearerAuth middleware', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('attaches AuthInfo to req.auth and calls next on a valid token', async () => {
        const validAuthInfo: AuthInfo = {
            token: 'valid-token',
            clientId: 'client-123',
            scopes: ['read', 'write'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600
        };
        mockVerifyAccessToken.mockResolvedValue(validAuthInfo);

        const { req, res, next } = createMockReqResNext('Bearer valid-token');
        const middleware = requireBearerAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid-token');
        expect(req.auth).toEqual(validAuthInfo);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('responds 401 with WWW-Authenticate (incl. resource_metadata) when header is missing', async () => {
        const { req, res, next } = createMockReqResNext(undefined);
        const middleware = requireBearerAuth({
            verifier: mockVerifier,
            resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource'
        });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.set).toHaveBeenCalledWith(
            'WWW-Authenticate',
            expect.stringMatching(
                /^Bearer error="invalid_token".*resource_metadata="https:\/\/api\.example\.com\/\.well-known\/oauth-protected-resource"$/
            )
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_token' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 when the verifier throws InvalidToken', async () => {
        mockVerifyAccessToken.mockRejectedValue(new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token'));

        const { req, res, next } = createMockReqResNext('Bearer nope');
        const middleware = requireBearerAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_token', error_description: 'unknown token' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 when the token is expired', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: 'expired',
            clientId: 'client-123',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) - 100
        } satisfies AuthInfo);

        const { req, res, next } = createMockReqResNext('Bearer expired');
        const middleware = requireBearerAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_token', error_description: 'Token has expired' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 403 with scope in WWW-Authenticate when required scopes are missing', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: 'valid',
            clientId: 'client-123',
            scopes: ['read'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600
        } satisfies AuthInfo);

        const { req, res, next } = createMockReqResNext('Bearer valid');
        const middleware = requireBearerAuth({ verifier: mockVerifier, requiredScopes: ['read', 'write'] });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('scope="read write"'));
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'insufficient_scope' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 500 when the verifier throws a non-OAuth error', async () => {
        mockVerifyAccessToken.mockRejectedValue(new Error('boom'));

        const { req, res, next } = createMockReqResNext('Bearer valid');
        const middleware = requireBearerAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }));
        expect(next).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// mcpAuthMetadataRouter + getOAuthProtectedResourceMetadataUrl
// ---------------------------------------------------------------------------

describe('mcpAuthMetadataRouter', () => {
    const oauthMetadata: OAuthMetadata = {
        issuer: 'https://auth.example.com/',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code']
    };

    it('serves PRM and AS metadata at the well-known endpoints', async () => {
        const app = express();
        app.use(
            mcpAuthMetadataRouter({
                oauthMetadata,
                resourceServerUrl: new URL('https://api.example.com/'),
                scopesSupported: ['read', 'write'],
                resourceName: 'Test API',
                serviceDocumentationUrl: new URL('https://docs.example.com/')
            })
        );

        const prm = await supertest(app).get('/.well-known/oauth-protected-resource');
        expect(prm.status).toBe(200);
        expect(prm.body.resource).toBe('https://api.example.com/');
        expect(prm.body.authorization_servers).toEqual(['https://auth.example.com/']);
        expect(prm.body.scopes_supported).toEqual(['read', 'write']);
        expect(prm.body.resource_name).toBe('Test API');
        expect(prm.body.resource_documentation).toBe('https://docs.example.com/');

        const as = await supertest(app).get('/.well-known/oauth-authorization-server');
        expect(as.status).toBe(200);
        expect(as.body.issuer).toBe('https://auth.example.com/');
        expect(as.body.token_endpoint).toBe('https://auth.example.com/token');
    });

    it('serves PRM at a path-aware route when resourceServerUrl has a path', async () => {
        const app = express();
        app.use(
            mcpAuthMetadataRouter({
                oauthMetadata,
                resourceServerUrl: new URL('https://api.example.com/mcp')
            })
        );

        const prm = await supertest(app).get('/.well-known/oauth-protected-resource/mcp');
        expect(prm.status).toBe(200);
        expect(prm.body.resource).toBe('https://api.example.com/mcp');
    });

    it('rejects non-GET methods on metadata endpoints with 405', async () => {
        const app = express();
        app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: new URL('https://api.example.com/') }));

        const res = await supertest(app).post('/.well-known/oauth-protected-resource');
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe('GET, OPTIONS');
        expect(res.body.error).toBe('method_not_allowed');
    });

    it('rejects non-HTTPS issuer URLs', () => {
        expect(() =>
            mcpAuthMetadataRouter({
                oauthMetadata: { ...oauthMetadata, issuer: 'http://auth.example.com/' },
                resourceServerUrl: new URL('https://api.example.com/')
            })
        ).toThrow('Issuer URL must be HTTPS');
    });
});

describe('getOAuthProtectedResourceMetadataUrl', () => {
    it('inserts the well-known prefix ahead of the path', () => {
        expect(getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/mcp'))).toBe(
            'https://api.example.com/.well-known/oauth-protected-resource/mcp'
        );
    });

    it('drops a bare root path', () => {
        expect(getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/'))).toBe(
            'https://api.example.com/.well-known/oauth-protected-resource'
        );
    });
});
