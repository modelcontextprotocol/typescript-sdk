// Type-only: see the matching comment in src/server/middleware/dpop.ts.
import type { webcrypto } from 'node:crypto';

import type { AuthInfo } from '@modelcontextprotocol/core-internal';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { calculateJwkThumbprint } from '../../src/server/middleware/dpop';
import type { DpopAuthOptions, OAuthTokenVerifier } from '../../src/server/middleware/dpopAuth';
import { dpopAuthChallengeResponse, requireDpopAuth, verifyDpopToken } from '../../src/server/middleware/dpopAuth';

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

async function buildProof(signer: Signer, htm: string, htu: string, accessToken: string, nonce?: string): Promise<string> {
    const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: signer.publicJwk };
    const athDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
    const payload: Record<string, unknown> = {
        jti: await base64url(crypto.getRandomValues(new Uint8Array(16))),
        htm,
        htu,
        iat: Math.floor(Date.now() / 1000),
        ath: await base64url(athDigest)
    };
    if (nonce !== undefined) payload.nonce = nonce;
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

function verifierFor(tokens: Record<string, AuthInfo>): OAuthTokenVerifier {
    return {
        verifyAccessToken: vi.fn(async (token: string) => {
            const info = tokens[token];
            if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
            return info;
        })
    };
}

const url = 'https://mcp.example.com/mcp';

describe('verifyDpopToken', () => {
    let signer: Signer;
    let boundToken: string;
    let options: DpopAuthOptions;

    beforeEach(async () => {
        signer = await generateSigner();
        boundToken = 'bound-token';
        options = {
            verifier: verifierFor({
                [boundToken]: {
                    token: boundToken,
                    clientId: 'client-1',
                    scopes: ['mcp'],
                    expiresAt: Math.floor(Date.now() / 1000) + 3600,
                    cnf: { jkt: signer.jkt }
                }
            }),
            requiredScopes: ['mcp']
        };
    });

    it('accepts a DPoP-bound token with a matching proof', async () => {
        const proof = await buildProof(signer, 'POST', url, boundToken);
        const authInfo = await verifyDpopToken({ authorization: `DPoP ${boundToken}`, dpop: proof, method: 'POST', url }, options);
        expect(authInfo.token).toBe(boundToken);
    });

    it('accepts a case-insensitive DPoP scheme', async () => {
        const proof = await buildProof(signer, 'POST', url, boundToken);
        await expect(
            verifyDpopToken({ authorization: `dPoP ${boundToken}`, dpop: proof, method: 'POST', url }, options)
        ).resolves.toMatchObject({ token: boundToken });
    });

    it('rejects a missing Authorization header', async () => {
        await expect(verifyDpopToken({ authorization: undefined, dpop: undefined, method: 'POST', url }, options)).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Missing Authorization header'
        });
    });

    it('rejects the Bearer scheme (RFC 9449 §7.2 — a DPoP-bound token must be presented as DPoP)', async () => {
        const proof = await buildProof(signer, 'POST', url, boundToken);
        await expect(
            verifyDpopToken({ authorization: `Bearer ${boundToken}`, dpop: proof, method: 'POST', url }, options)
        ).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: "Invalid Authorization header format, expected 'DPoP TOKEN'"
        });
    });

    it('rejects a missing/malformed proof, surfacing the invalid_dpop_proof error from verifyDpopProof', async () => {
        await expect(
            verifyDpopToken({ authorization: `DPoP ${boundToken}`, dpop: undefined, method: 'POST', url }, options)
        ).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
    });

    it('rejects when the proof key does not match the token cnf.jkt (RFC 9449 §4.3 step 12b)', async () => {
        const otherSigner = await generateSigner();
        const proof = await buildProof(otherSigner, 'POST', url, boundToken);
        await expect(
            verifyDpopToken({ authorization: `DPoP ${boundToken}`, dpop: proof, method: 'POST', url }, options)
        ).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Access token is not bound to this proof key (cnf.jkt mismatch)'
        });
    });

    it('rejects a token the verifier never bound (no cnf at all) presented under DPoP', async () => {
        const unboundToken = 'unbound-token';
        const unboundOptions: DpopAuthOptions = {
            verifier: verifierFor({
                [unboundToken]: { token: unboundToken, clientId: 'c', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 3600 }
            })
        };
        const proof = await buildProof(signer, 'POST', url, unboundToken);
        await expect(
            verifyDpopToken({ authorization: `DPoP ${unboundToken}`, dpop: proof, method: 'POST', url }, unboundOptions)
        ).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Access token is not bound to this proof key (cnf.jkt mismatch)'
        });
    });

    it('enforces requiredScopes after the proof/binding checks', async () => {
        const scopedOptions: DpopAuthOptions = { ...options, requiredScopes: ['admin'] };
        const proof = await buildProof(signer, 'POST', url, boundToken);
        await expect(
            verifyDpopToken({ authorization: `DPoP ${boundToken}`, dpop: proof, method: 'POST', url }, scopedOptions)
        ).rejects.toMatchObject({ code: OAuthErrorCode.InsufficientScope });
    });

    it('rejects an expired token', async () => {
        const expiredToken = 'expired-token';
        const expiredOptions: DpopAuthOptions = {
            verifier: verifierFor({
                [expiredToken]: {
                    token: expiredToken,
                    clientId: 'c',
                    scopes: ['mcp'],
                    expiresAt: Math.floor(Date.now() / 1000) - 100,
                    cnf: { jkt: signer.jkt }
                }
            })
        };
        const proof = await buildProof(signer, 'POST', url, expiredToken);
        await expect(
            verifyDpopToken({ authorization: `DPoP ${expiredToken}`, dpop: proof, method: 'POST', url }, expiredOptions)
        ).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken, message: 'Token has expired' });
    });

    describe('server-provided nonce', () => {
        it('rejects when a nonce is required and absent, and accepts once the correct one is presented', async () => {
            const currentNonce = 'nonce-1';
            const nonceOptions: DpopAuthOptions = {
                ...options,
                nonce: { issue: () => currentNonce, verify: (n: string | undefined) => n === currentNonce }
            };

            const proofNoNonce = await buildProof(signer, 'POST', url, boundToken);
            await expect(
                verifyDpopToken({ authorization: `DPoP ${boundToken}`, dpop: proofNoNonce, method: 'POST', url }, nonceOptions)
            ).rejects.toMatchObject({ code: 'use_dpop_nonce' });

            const proofWithNonce = await buildProof(signer, 'POST', url, boundToken, currentNonce);
            await expect(
                verifyDpopToken({ authorization: `DPoP ${boundToken}`, dpop: proofWithNonce, method: 'POST', url }, nonceOptions)
            ).resolves.toMatchObject({ token: boundToken });
        });
    });
});

describe('verifyDpopToken with a JWT-shaped access token', () => {
    // The tests above all use short opaque strings as the access token, matching an
    // introspection-backed OAuthTokenVerifier. This proves the same flow when the access token is
    // itself a signed JWT (header.payload.signature) whose own payload carries `cnf.jkt` — the
    // shape a self-contained JWT-access-token verifier decodes instead of looking up.
    function buildJwtAccessToken(payload: Record<string, unknown>): string {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const header = encode({ alg: 'RS256', typ: 'JWT' });
        const body = encode(payload);
        // Verifying the access token's own signature is the OAuthTokenVerifier's job, not
        // dpop.ts's, so a placeholder signature segment is enough to keep the token JWT-shaped.
        return `${header}.${body}.${Buffer.from('sig').toString('base64url')}`;
    }

    function jwtDecodingVerifier(): OAuthTokenVerifier {
        return {
            verifyAccessToken: vi.fn(async (token: string) => {
                const [, payloadSegment] = token.split('.');
                if (!payloadSegment) throw new OAuthError(OAuthErrorCode.InvalidToken, 'not a JWT');
                const claims = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as Record<string, unknown>;
                return {
                    token,
                    clientId: claims.client_id as string,
                    scopes: (claims.scope as string).split(' '),
                    expiresAt: claims.exp as number,
                    cnf: claims.cnf as { jkt?: string } | undefined
                };
            })
        };
    }

    it('accepts a DPoP-bound token when the access token is a real JWT, decoded (not looked up) by the verifier', async () => {
        const signer = await generateSigner();
        const jwtAccessToken = buildJwtAccessToken({
            client_id: 'client-1',
            scope: 'mcp',
            exp: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: signer.jkt }
        });
        const proof = await buildProof(signer, 'POST', url, jwtAccessToken);
        const authInfo = await verifyDpopToken(
            { authorization: `DPoP ${jwtAccessToken}`, dpop: proof, method: 'POST', url },
            { verifier: jwtDecodingVerifier(), requiredScopes: ['mcp'] }
        );
        expect(authInfo.token).toBe(jwtAccessToken);
        expect(authInfo.cnf?.jkt).toBe(signer.jkt);
    });

    it('rejects when the JWT access token is bound to a different proof key', async () => {
        const signer = await generateSigner();
        const otherSigner = await generateSigner();
        const jwtAccessToken = buildJwtAccessToken({
            client_id: 'client-1',
            scope: 'mcp',
            exp: Math.floor(Date.now() / 1000) + 3600,
            cnf: { jkt: otherSigner.jkt }
        });
        const proof = await buildProof(signer, 'POST', url, jwtAccessToken);
        await expect(
            verifyDpopToken(
                { authorization: `DPoP ${jwtAccessToken}`, dpop: proof, method: 'POST', url },
                { verifier: jwtDecodingVerifier() }
            )
        ).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Access token is not bound to this proof key (cnf.jkt mismatch)'
        });
    });
});

describe('dpopAuthChallengeResponse', () => {
    it('answers 401 with a DPoP challenge (advertising algs) for invalid_dpop_proof', async () => {
        const response = dpopAuthChallengeResponse(new OAuthError('invalid_dpop_proof', 'DPoP proof signature does not verify'), {
            requiredScopes: ['mcp'],
            resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource'
        });
        expect(response.status).toBe(401);
        const challenge = response.headers.get('WWW-Authenticate') ?? '';
        expect(challenge).toMatch(/^DPoP error="invalid_dpop_proof"/);
        expect(challenge).toContain('scope="mcp"');
        expect(challenge).toContain('resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"');
        expect(challenge).toContain('algs="ES256 ES384 ES512 RS256 RS384 RS512 PS256 PS384 PS512 EdDSA"');
    });

    it('answers 401 for invalid_token with the same DPoP challenge shape', async () => {
        const response = dpopAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'Token has expired'));
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toMatch(/^DPoP error="invalid_token"/);
    });

    it('answers 401 with a DPoP-Nonce header for use_dpop_nonce, minted by options.nonce.issue()', async () => {
        const issue = vi.fn().mockReturnValue('fresh-nonce-1');
        const response = dpopAuthChallengeResponse(new OAuthError('use_dpop_nonce', 'a fresh server-provided nonce is required'), {
            nonce: { issue, verify: () => false }
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('DPoP-Nonce')).toBe('fresh-nonce-1');
        expect(issue).toHaveBeenCalledTimes(1);
    });

    it('does not set DPoP-Nonce for use_dpop_nonce when no nonce option is configured', async () => {
        const response = dpopAuthChallengeResponse(new OAuthError('use_dpop_nonce', 'x'));
        expect(response.headers.get('DPoP-Nonce')).toBeNull();
    });

    it('answers 403 for insufficient_scope', async () => {
        const response = dpopAuthChallengeResponse(new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope'), {
            requiredScopes: ['admin']
        });
        expect(response.status).toBe(403);
        expect(response.headers.get('WWW-Authenticate')).toContain('scope="admin"');
    });

    it('answers 500 without a challenge for server_error and for non-OAuthError values', async () => {
        const a = dpopAuthChallengeResponse(new OAuthError(OAuthErrorCode.ServerError, 'boom'));
        expect(a.status).toBe(500);
        expect(a.headers.get('WWW-Authenticate')).toBeNull();

        const b = dpopAuthChallengeResponse(new Error('boom'));
        expect(b.status).toBe(500);
        expect(await b.json()).toMatchObject({ error: 'server_error' });
    });

    it('answers 400 without a challenge for any other OAuth error code', async () => {
        const response = dpopAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidRequest, 'nope'));
        expect(response.status).toBe(400);
        expect(response.headers.get('WWW-Authenticate')).toBeNull();
    });
});

describe('requireDpopAuth (web-standard)', () => {
    it('resolves to AuthInfo for a valid request', async () => {
        const signer = await generateSigner();
        const token = 'tok-1';
        const gate = requireDpopAuth({
            verifier: verifierFor({
                [token]: { token, clientId: 'c', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, cnf: { jkt: signer.jkt } }
            })
        });
        const proof = await buildProof(signer, 'POST', url, token);
        const result = await gate(new Request(url, { method: 'POST', headers: { Authorization: `DPoP ${token}`, DPoP: proof } }));
        expect(result).toMatchObject({ token });
    });

    it('resolves to the 401 challenge Response for a missing proof', async () => {
        const gate = requireDpopAuth({ verifier: verifierFor({}) });
        const result = await gate(new Request(url, { method: 'POST', headers: { Authorization: 'DPoP whatever' } }));
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });

    it('throws at creation time for missing options', () => {
        expect(() => requireDpopAuth(undefined as never)).toThrow(TypeError);
    });
});
