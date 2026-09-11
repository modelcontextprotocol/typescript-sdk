// Type-only: see the matching comment in src/server/middleware/dpop.ts.
import type { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { accessTokenHash, calculateJwkThumbprint, DPOP_SUPPORTED_ALGS, verifyDpopProof } from '../../src/server/middleware/dpop';

/**
 * Minimal, hand-rolled DPoP proof builder for these tests — deliberately independent of
 * `dpop.ts`'s own validator (built on the same raw WebCrypto primitives, not through it), so a
 * shared bug in signing/encoding can't hide from the tests that exercise the validator.
 */
async function base64url(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    return Buffer.from(bytes as ArrayBuffer).toString('base64url');
}

interface TestKeyPair {
    privateKey: webcrypto.CryptoKey;
    publicJwk: webcrypto.JsonWebKey;
}

async function generateEcKeyPair(): Promise<TestKeyPair> {
    const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    return { privateKey, publicJwk };
}

interface BuildProofOptions {
    kp: TestKeyPair;
    htm: string;
    htu: string;
    accessToken?: string;
    nonce?: string;
    iat?: number;
    alg?: string;
    typ?: string;
    jwk?: unknown;
    omit?: Array<'jti' | 'htm' | 'htu' | 'iat' | 'jwk'>;
    tamperSignature?: boolean;
}

async function buildProof(opts: BuildProofOptions): Promise<string> {
    const omit = new Set(opts.omit);
    const header: Record<string, unknown> = { alg: opts.alg ?? 'ES256', typ: opts.typ === undefined ? 'dpop+jwt' : opts.typ };
    if (!omit.has('jwk')) header.jwk = opts.jwk ?? opts.kp.publicJwk;

    const payload: Record<string, unknown> = {};
    if (!omit.has('jti')) payload.jti = await base64url(crypto.getRandomValues(new Uint8Array(16)));
    if (!omit.has('htm')) payload.htm = opts.htm;
    if (!omit.has('htu')) payload.htu = opts.htu;
    if (!omit.has('iat')) payload.iat = opts.iat ?? Math.floor(Date.now() / 1000);
    if (opts.accessToken !== undefined) payload.ath = await accessTokenHash(opts.accessToken);
    if (opts.nonce !== undefined) payload.nonce = opts.nonce;

    const headerSegment = await base64url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadSegment = await base64url(new TextEncoder().encode(JSON.stringify(payload)));
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        opts.kp.privateKey,
        new TextEncoder().encode(signingInput)
    );
    let signatureSegment = await base64url(signature);
    if (opts.tamperSignature) {
        signatureSegment = (signatureSegment[0] === 'A' ? 'B' : 'A') + signatureSegment.slice(1);
    }
    return `${signingInput}.${signatureSegment}`;
}

async function buildHs256Proof(kp: TestKeyPair, htm: string, htu: string, accessToken: string): Promise<string> {
    const secretKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
    const header = { alg: 'HS256', typ: 'dpop+jwt', jwk: kp.publicJwk };
    const payload = {
        jti: await base64url(crypto.getRandomValues(new Uint8Array(16))),
        htm,
        htu,
        iat: Math.floor(Date.now() / 1000),
        ath: await accessTokenHash(accessToken)
    };
    const headerSegment = await base64url(new TextEncoder().encode(JSON.stringify(header)));
    const payloadSegment = await base64url(new TextEncoder().encode(JSON.stringify(payload)));
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = await crypto.subtle.sign('HMAC', secretKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${await base64url(signature)}`;
}

function unsignedNoneProof(htm: string, htu: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'dpop+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ jti: 'x', htm, htu, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    return `${header}.${payload}.`;
}

describe('calculateJwkThumbprint', () => {
    it('produces the RFC 7638 §3.1 example thumbprint for an RSA key', async () => {
        // RFC 7638 §3.1 test vector — the published expected thumbprint for this exact JWK.
        const rsaJwk = {
            kty: 'RSA',
            n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
            e: 'AQAB'
        };
        expect(await calculateJwkThumbprint(rsaJwk)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
    });

    it('is order-independent — permuting the input JWK member order yields the same thumbprint', async () => {
        const kp = await generateEcKeyPair();
        const a = await calculateJwkThumbprint(kp.publicJwk);
        const permuted = {
            y: (kp.publicJwk as { y: string }).y,
            crv: kp.publicJwk.crv,
            x: (kp.publicJwk as { x: string }).x,
            kty: kp.publicJwk.kty
        };
        const b = await calculateJwkThumbprint(permuted);
        expect(a).toBe(b);
    });

    it('differs for two distinct keys', async () => {
        const a = await generateEcKeyPair();
        const b = await generateEcKeyPair();
        expect(await calculateJwkThumbprint(a.publicJwk)).not.toBe(await calculateJwkThumbprint(b.publicJwk));
    });
});

describe('accessTokenHash', () => {
    it('matches an independently computed SHA-256/base64url digest', async () => {
        const expected = await base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tok-123')));
        expect(await accessTokenHash('tok-123')).toBe(expected);
    });
});

describe('verifyDpopProof', () => {
    const url = 'https://mcp.example.com/mcp';
    let kp: TestKeyPair;

    beforeEach(async () => {
        kp = await generateEcKeyPair();
    });

    it('accepts a valid proof and returns the matching jkt + claims', async () => {
        const proof = await buildProof({ kp, htm: 'POST', htu: url, accessToken: 'tok-1' });
        const result = await verifyDpopProof({ proof, method: 'POST', url, accessToken: 'tok-1' });
        expect(result.jkt).toBe(await calculateJwkThumbprint(kp.publicJwk));
        expect(typeof result.claims.jti).toBe('string');
        expect(result.claims.htm).toBe('POST');
        expect(result.claims.htu).toBe(url);
    });

    it('compares htm case-insensitively', async () => {
        const proof = await buildProof({ kp, htm: 'POST', htu: url });
        await expect(verifyDpopProof({ proof, method: 'post', url })).resolves.toBeDefined();
    });

    for (const alg of DPOP_SUPPORTED_ALGS) {
        it(`accepts a valid ${alg} proof`, async () => {
            let signAlgorithm: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams | webcrypto.RsaPssParams;
            let genAlgorithm: webcrypto.RsaHashedKeyGenParams | webcrypto.EcKeyGenParams | webcrypto.AlgorithmIdentifier;
            switch (alg) {
                case 'ES256': {
                    genAlgorithm = { name: 'ECDSA', namedCurve: 'P-256' };
                    signAlgorithm = { name: 'ECDSA', hash: 'SHA-256' };
                    break;
                }
                case 'ES384': {
                    genAlgorithm = { name: 'ECDSA', namedCurve: 'P-384' };
                    signAlgorithm = { name: 'ECDSA', hash: 'SHA-384' };
                    break;
                }
                case 'ES512': {
                    genAlgorithm = { name: 'ECDSA', namedCurve: 'P-521' };
                    signAlgorithm = { name: 'ECDSA', hash: 'SHA-512' };
                    break;
                }
                case 'RS256': {
                    genAlgorithm = {
                        name: 'RSASSA-PKCS1-v1_5',
                        modulusLength: 2048,
                        publicExponent: new Uint8Array([1, 0, 1]),
                        hash: 'SHA-256'
                    };
                    signAlgorithm = { name: 'RSASSA-PKCS1-v1_5' };
                    break;
                }
                case 'RS384': {
                    genAlgorithm = {
                        name: 'RSASSA-PKCS1-v1_5',
                        modulusLength: 2048,
                        publicExponent: new Uint8Array([1, 0, 1]),
                        hash: 'SHA-384'
                    };
                    signAlgorithm = { name: 'RSASSA-PKCS1-v1_5' };
                    break;
                }
                case 'RS512': {
                    genAlgorithm = {
                        name: 'RSASSA-PKCS1-v1_5',
                        modulusLength: 2048,
                        publicExponent: new Uint8Array([1, 0, 1]),
                        hash: 'SHA-512'
                    };
                    signAlgorithm = { name: 'RSASSA-PKCS1-v1_5' };
                    break;
                }
                case 'PS256': {
                    genAlgorithm = { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
                    signAlgorithm = { name: 'RSA-PSS', saltLength: 32 };
                    break;
                }
                case 'PS384': {
                    genAlgorithm = { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' };
                    signAlgorithm = { name: 'RSA-PSS', saltLength: 48 };
                    break;
                }
                case 'PS512': {
                    genAlgorithm = { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' };
                    signAlgorithm = { name: 'RSA-PSS', saltLength: 64 };
                    break;
                }
                case 'EdDSA': {
                    genAlgorithm = { name: 'Ed25519' };
                    signAlgorithm = { name: 'Ed25519' };
                    break;
                }
            }
            const { publicKey, privateKey } = (await crypto.subtle.generateKey(genAlgorithm, true, [
                'sign',
                'verify'
            ])) as webcrypto.CryptoKeyPair;
            const signKp: TestKeyPair = { privateKey, publicJwk: await crypto.subtle.exportKey('jwk', publicKey) };

            const header = { alg, typ: 'dpop+jwt', jwk: signKp.publicJwk };
            const payload = {
                jti: await base64url(crypto.getRandomValues(new Uint8Array(16))),
                htm: 'POST',
                htu: url,
                iat: Math.floor(Date.now() / 1000)
            };
            const headerSegment = await base64url(new TextEncoder().encode(JSON.stringify(header)));
            const payloadSegment = await base64url(new TextEncoder().encode(JSON.stringify(payload)));
            const signingInput = `${headerSegment}.${payloadSegment}`;
            const signature = await crypto.subtle.sign(signAlgorithm, signKp.privateKey, new TextEncoder().encode(signingInput));
            const proof = `${signingInput}.${await base64url(signature)}`;

            const result = await verifyDpopProof({ proof, method: 'POST', url });
            expect(result.jkt).toBe(await calculateJwkThumbprint(signKp.publicJwk));
        });
    }

    describe('rejections (RFC 9449 §4.3)', () => {
        it('rejects a missing proof', async () => {
            await expect(verifyDpopProof({ proof: undefined, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a non-JWT string', async () => {
            await expect(verifyDpopProof({ proof: 'not-a-jwt', method: 'POST', url })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });

        it('rejects a tampered signature', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, tamperSignature: true });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects wrong typ', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, typ: 'jwt' });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects alg: none', async () => {
            const proof = unsignedNoneProof('POST', url);
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a symmetric algorithm (HS256)', async () => {
            const proof = await buildHs256Proof(kp, 'POST', url, 'tok-1');
            await expect(verifyDpopProof({ proof, method: 'POST', url, accessToken: 'tok-1' })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });

        it('rejects a private key embedded in jwk', async () => {
            const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
            const proof = await buildProof({ kp, htm: 'POST', htu: url, jwk: privateJwk });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a missing jwk', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, omit: ['jwk'] });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a missing jti', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, omit: ['jti'] });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a missing htm', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, omit: ['htm'] });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects an htm mismatch', async () => {
            const proof = await buildProof({ kp, htm: 'GET', htu: url });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a missing htu', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, omit: ['htu'] });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects an htu mismatch', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: 'https://wrong.example.com/mcp' });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects an htu carrying a query string (even if it matches after stripping)', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: `${url}?x=1` });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects an htu carrying a fragment', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: `${url}#frag` });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a missing iat', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, omit: ['iat'] });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a stale iat (outside ±300s default window)', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000) - 301 });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('rejects a future iat (outside ±300s default window)', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000) + 301 });
            await expect(verifyDpopProof({ proof, method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });

        it('accepts an iat just inside a custom acceptance window', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000) - 50 });
            await expect(verifyDpopProof({ proof, method: 'POST', url, iatSkewSeconds: 60 })).resolves.toBeDefined();
        });

        it('rejects a missing ath when an access token is presented', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url }); // no accessToken -> no ath claim
            await expect(verifyDpopProof({ proof, method: 'POST', url, accessToken: 'tok-1' })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });

        it('rejects a wrong ath', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, accessToken: 'tok-1' });
            await expect(verifyDpopProof({ proof, method: 'POST', url, accessToken: 'tok-2' })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });

        it('rejects a duplicate DPoP header presented as an array of two', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url });
            await expect(verifyDpopProof({ proof: [proof, proof], method: 'POST', url })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });

        it('rejects a duplicate DPoP header collapsed into one comma-joined string (Node http behavior)', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url });
            await expect(verifyDpopProof({ proof: `${proof}, ${proof}`, method: 'POST', url })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });

        it('rejects an empty array (no proof at all, distinctly from "too many")', async () => {
            await expect(verifyDpopProof({ proof: [], method: 'POST', url })).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
        });
    });

    describe('htu normalization', () => {
        it('tolerates the default port and a single trailing slash', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: 'https://mcp.example.com:443/mcp/' });
            await expect(verifyDpopProof({ proof, method: 'POST', url: 'https://mcp.example.com/mcp' })).resolves.toBeDefined();
        });

        it('does not tolerate a non-default port mismatch', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: 'https://mcp.example.com:8443/mcp' });
            await expect(verifyDpopProof({ proof, method: 'POST', url: 'https://mcp.example.com/mcp' })).rejects.toMatchObject({
                code: 'invalid_dpop_proof'
            });
        });
    });

    describe('server-provided nonce (RFC 9449 §9)', () => {
        it('accepts a nonce-less proof when no nonce is currently required', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url });
            const nonce = { verify: () => true };
            await expect(verifyDpopProof({ proof, method: 'POST', url, nonce })).resolves.toBeDefined();
        });

        it('rejects a nonce-less proof when a nonce is required', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url });
            const nonce = { verify: (n: string | undefined) => n === 'expected-nonce' };
            await expect(verifyDpopProof({ proof, method: 'POST', url, nonce })).rejects.toMatchObject({ code: 'use_dpop_nonce' });
        });

        it('rejects a wrong nonce', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, nonce: 'not-it' });
            const nonce = { verify: (n: string | undefined) => n === 'expected-nonce' };
            await expect(verifyDpopProof({ proof, method: 'POST', url, nonce })).rejects.toMatchObject({ code: 'use_dpop_nonce' });
        });

        it('accepts the correct nonce', async () => {
            const proof = await buildProof({ kp, htm: 'POST', htu: url, nonce: 'expected-nonce' });
            const nonce = { verify: (n: string | undefined) => n === 'expected-nonce' };
            const result = await verifyDpopProof({ proof, method: 'POST', url, nonce });
            expect(result.claims.nonce).toBe('expected-nonce');
        });
    });
});
