// Type-only: see the matching comment in @modelcontextprotocol/server's src/server/middleware/dpop.ts.
import type { webcrypto } from 'node:crypto';

import type { AuthInfo, DpopAuthOptions, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { calculateJwkThumbprint } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import express from 'express';
import supertest from 'supertest';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requireDpopAuth } from '../../src/auth/dpopAuth';

async function base64url(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    return Buffer.from(bytes as ArrayBuffer).toString('base64url');
}

interface Signer {
    privateKey: webcrypto.CryptoKey;
    publicJwk: webcrypto.JsonWebKey;
    jkt: string;
}

async function generateSigner(): Promise<Signer> {
    const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    return { privateKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk) };
}

async function buildProof(signer: Signer, htm: string, htu: string, accessToken: string): Promise<string> {
    const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: signer.publicJwk };
    const athDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
    const payload = {
        jti: await base64url(crypto.getRandomValues(new Uint8Array(16))),
        htm,
        htu,
        iat: Math.floor(Date.now() / 1000),
        ath: await base64url(athDigest)
    };
    const headerSegment = await base64url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadSegment = await base64url(new TextEncoder().encode(JSON.stringify(payload)));
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signer.privateKey,
        new TextEncoder().encode(signingInput)
    );
    return `${signingInput}.${await base64url(signature)}`;
}

const mockVerifyAccessToken = vi.fn();
const mockVerifier: OAuthTokenVerifier = { verifyAccessToken: mockVerifyAccessToken };

function createMockReqResNext(authorization?: string, dpop?: string) {
    const req = {
        headers: { authorization, dpop },
        method: 'POST',
        protocol: 'https',
        originalUrl: '/mcp',
        get: () => 'mcp.example.com'
    } as unknown as Request;
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis()
    } as unknown as Response;
    const next = vi.fn();
    return { req, res, next };
}

describe('requireDpopAuth middleware (mocked req/res)', () => {
    let signer: Signer;
    let boundToken: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        signer = await generateSigner();
        boundToken = 'valid-token';
    });

    it('attaches AuthInfo to req.auth and calls next on a valid DPoP-bound request', async () => {
        const authInfo: AuthInfo = {
            token: boundToken,
            clientId: 'client-123',
            scopes: ['mcp'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        };
        mockVerifyAccessToken.mockResolvedValue(authInfo);
        const proof = await buildProof(signer, 'POST', 'https://mcp.example.com/mcp', boundToken);

        const { req, res, next } = createMockReqResNext(`DPoP ${boundToken}`, proof);
        const middleware = requireDpopAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(mockVerifyAccessToken).toHaveBeenCalledWith(boundToken);
        expect(req.auth).toEqual(authInfo);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('responds 401 with a DPoP WWW-Authenticate challenge when the proof header is missing', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: boundToken,
            clientId: 'client-123',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });
        const { req, res, next } = createMockReqResNext(`DPoP ${boundToken}`, undefined);
        const middleware = requireDpopAuth({
            verifier: mockVerifier,
            resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource'
        });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.set).toHaveBeenCalledWith(
            'WWW-Authenticate',
            expect.stringMatching(
                /^DPoP error="invalid_dpop_proof".*resource_metadata="https:\/\/api\.example\.com\/\.well-known\/oauth-protected-resource".*algs="ES256/
            )
        );
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_dpop_proof' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 rejecting the Bearer scheme on a DPoP-only gate', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: boundToken,
            clientId: 'client-123',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });
        const proof = await buildProof(signer, 'POST', 'https://mcp.example.com/mcp', boundToken);
        const { req, res, next } = createMockReqResNext(`Bearer ${boundToken}`, proof);
        const middleware = requireDpopAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 when the proof key does not match the token cnf.jkt', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: boundToken,
            clientId: 'client-123',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });
        const otherSigner = await generateSigner();
        const wrongProof = await buildProof(otherSigner, 'POST', 'https://mcp.example.com/mcp', boundToken);
        const { req, res, next } = createMockReqResNext(`DPoP ${boundToken}`, wrongProof);
        const middleware = requireDpopAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error_description: expect.stringContaining('cnf.jkt') }));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 403 with scope in WWW-Authenticate when required scopes are missing', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: boundToken,
            clientId: 'client-123',
            scopes: ['read'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });
        const proof = await buildProof(signer, 'POST', 'https://mcp.example.com/mcp', boundToken);
        const { req, res, next } = createMockReqResNext(`DPoP ${boundToken}`, proof);
        const middleware = requireDpopAuth({ verifier: mockVerifier, requiredScopes: ['read', 'write'] });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('scope="read write"'));
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 401 with a DPoP-Nonce header when a nonce is required and issued', async () => {
        mockVerifyAccessToken.mockResolvedValue({
            token: boundToken,
            clientId: 'client-123',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });
        const proof = await buildProof(signer, 'POST', 'https://mcp.example.com/mcp', boundToken);
        const { req, res, next } = createMockReqResNext(`DPoP ${boundToken}`, proof);
        const options: DpopAuthOptions = { verifier: mockVerifier, nonce: { issue: () => 'fresh-nonce', verify: () => false } };
        const middleware = requireDpopAuth(options);
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.set).toHaveBeenCalledWith('DPoP-Nonce', 'fresh-nonce');
        expect(next).not.toHaveBeenCalled();
    });

    it('responds 500 when the verifier throws a non-OAuth error', async () => {
        mockVerifyAccessToken.mockRejectedValue(new Error('boom'));
        const proof = await buildProof(signer, 'POST', 'https://mcp.example.com/mcp', boundToken);
        const { req, res, next } = createMockReqResNext(`DPoP ${boundToken}`, proof);
        const middleware = requireDpopAuth({ verifier: mockVerifier });
        await middleware(req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }));
        expect(next).not.toHaveBeenCalled();
    });

    it('throws at creation time for missing options', () => {
        expect(() => requireDpopAuth(undefined as never)).toThrow(TypeError);
    });
});

describe('requireDpopAuth middleware (real HTTP round trip)', () => {
    // A real listening server (not supertest) — the middleware reconstructs `htu` from
    // req.protocol/req.get('host')/req.originalUrl, so the proof must be built against the exact
    // externally-visible URL the client used, which supertest's abstraction obscures.
    async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
        const server = app.listen(0, '127.0.0.1');
        await new Promise<void>(resolve => server.once('listening', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('no address');
        try {
            return await run(`http://127.0.0.1:${address.port}`);
        } finally {
            server.close();
        }
    }

    it('reconstructs htu from the request and accepts a matching proof', async () => {
        const signer = await generateSigner();
        const token = 'e2e-token';
        const verifyAccessToken: Mock = vi.fn().mockResolvedValue({
            token,
            clientId: 'client-1',
            scopes: ['mcp'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });

        const app = express();
        app.use('/mcp', requireDpopAuth({ verifier: { verifyAccessToken }, requiredScopes: ['mcp'] }));
        app.post('/mcp', (req, res) => res.json({ ok: true, clientId: req.auth?.clientId }));

        await withServer(app, async baseUrl => {
            const proof = await buildProof(signer, 'POST', `${baseUrl}/mcp`, token);
            const res = await fetch(`${baseUrl}/mcp`, {
                method: 'POST',
                headers: { Authorization: `DPoP ${token}`, DPoP: proof, 'content-type': 'application/json' },
                body: '{}'
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ ok: true, clientId: 'client-1' });
        });
    });

    it('rejects a proof signed for a different path (htu mismatch)', async () => {
        const signer = await generateSigner();
        const token = 'e2e-token';
        const verifyAccessToken: Mock = vi.fn().mockResolvedValue({
            token,
            clientId: 'client-1',
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });

        const app = express();
        app.use('/mcp', requireDpopAuth({ verifier: { verifyAccessToken } }));
        app.post('/mcp', (_req, res) => res.json({ ok: true }));

        await withServer(app, async baseUrl => {
            const proof = await buildProof(signer, 'POST', `${baseUrl}/wrong-path`, token);
            const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } });
            expect(res.status).toBe(401);
            const body = (await res.json()) as { error?: string };
            expect(body.error).toBe('invalid_dpop_proof');
        });
    });

    it('rejects a request with no Authorization header at all', async () => {
        const app = express();
        app.use('/mcp', requireDpopAuth({ verifier: { verifyAccessToken: vi.fn() } }));
        app.post('/mcp', (_req, res) => res.json({ ok: true }));

        const res = await supertest(app).post('/mcp');
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/^DPoP /);
    });
});
