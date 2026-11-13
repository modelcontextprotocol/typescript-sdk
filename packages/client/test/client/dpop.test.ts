import { accessTokenHash, DPOP_SUPPORTED_ALGS, DpopSession, generateDpopKeyPair, isDpopNonceChallenge } from '../../src/client/dpop';

function decodeJwtPart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('generateDpopKeyPair', () => {
    it('defaults to ES256 and produces a matching thumbprint', async () => {
        const kp = await generateDpopKeyPair();
        expect(kp.alg).toBe('ES256');
        expect(kp.publicJwk.kty).toBe('EC');
        expect(kp.publicJwk.crv).toBe('P-256');
        expect(kp.publicJwk.d).toBeUndefined();
        expect(typeof kp.thumbprint).toBe('string');
        expect(kp.thumbprint.length).toBeGreaterThan(0);
    });

    it('generates a non-extractable private key by default', async () => {
        const kp = await generateDpopKeyPair();
        expect(kp.privateKey.extractable).toBe(false);
    });

    it('honors extractable: true for callers that need to export the key', async () => {
        const kp = await generateDpopKeyPair({ extractable: true });
        expect(kp.privateKey.extractable).toBe(true);
    });

    it('produces distinct key pairs (and thumbprints) across calls', async () => {
        const a = await generateDpopKeyPair();
        const b = await generateDpopKeyPair();
        expect(a.thumbprint).not.toBe(b.thumbprint);
    });
});

describe('accessTokenHash', () => {
    it('is the base64url SHA-256 digest of the token (RFC 9449 §4.1)', async () => {
        const hash = await accessTokenHash('some-access-token');
        // Independently computed expected digest (Node's webcrypto, not this module's code path).
        const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('some-access-token'))).toString(
            'base64url'
        );
        expect(hash).toBe(expected);
    });

    it('is base64url, not base64 (no +, /, or = padding)', async () => {
        const hash = await accessTokenHash('token-that-might-produce-padding-or-special-chars');
        expect(hash).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('DpopSession.buildProof', () => {
    it('produces a well-formed dpop+jwt proof with the expected header shape', async () => {
        const session = await DpopSession.create();
        const proof = await session.buildProof({ htm: 'post', htu: 'https://mcp.example.com/mcp' });
        const [headerPart, payloadPart, signaturePart] = proof.split('.');
        expect(headerPart).toBeDefined();
        expect(payloadPart).toBeDefined();
        expect(signaturePart!.length).toBeGreaterThan(0);

        const header = decodeJwtPart(headerPart!);
        expect(header.typ).toBe('dpop+jwt');
        expect(header.alg).toBe('ES256');
        expect(header.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
        expect((header.jwk as Record<string, unknown>).d).toBeUndefined();
    });

    it('normalizes htm to upper-case and strips query/fragment from htu', async () => {
        const session = await DpopSession.create();
        const proof = await session.buildProof({ htm: 'post', htu: 'https://mcp.example.com/mcp?foo=bar#frag' });
        const payload = decodeJwtPart(proof.split('.')[1]!);
        expect(payload.htm).toBe('POST');
        expect(payload.htu).toBe('https://mcp.example.com/mcp');
    });

    it('mints a fresh jti on every call — never caches or reuses a proof', async () => {
        const session = await DpopSession.create();
        const first = await session.buildProof({ htm: 'GET', htu: 'https://mcp.example.com/mcp' });
        const second = await session.buildProof({ htm: 'GET', htu: 'https://mcp.example.com/mcp' });
        expect(first).not.toBe(second);
        const jti1 = decodeJwtPart(first.split('.')[1]!).jti;
        const jti2 = decodeJwtPart(second.split('.')[1]!).jti;
        expect(jti1).not.toBe(jti2);
    });

    it('includes ath only when an accessToken is provided', async () => {
        const session = await DpopSession.create();
        const proofWithToken = await session.buildProof({ htm: 'GET', htu: 'https://mcp.example.com/mcp', accessToken: 'tok' });
        const withToken = decodeJwtPart(proofWithToken.split('.')[1]!);
        expect(withToken.ath).toBe(await accessTokenHash('tok'));

        const proofWithoutToken = await session.buildProof({ htm: 'GET', htu: 'https://mcp.example.com/mcp' });
        const withoutToken = decodeJwtPart(proofWithoutToken.split('.')[1]!);
        expect(withoutToken.ath).toBeUndefined();
    });

    it('automatically carries the remembered nonce for a URL once one has been observed', async () => {
        const session = await DpopSession.create();
        const url = 'https://mcp.example.com/mcp';
        session.rememberNonce(url, 'server-nonce-1');
        const proof = await session.buildProof({ htm: 'POST', htu: url });
        const payload = decodeJwtPart(proof.split('.')[1]!);
        expect(payload.nonce).toBe('server-nonce-1');
    });

    it('an explicit nonce option overrides the remembered one', async () => {
        const session = await DpopSession.create();
        const url = 'https://mcp.example.com/mcp';
        session.rememberNonce(url, 'remembered');
        const proof = await session.buildProof({ htm: 'POST', htu: url, nonce: 'explicit' });
        const payload = decodeJwtPart(proof.split('.')[1]!);
        expect(payload.nonce).toBe('explicit');
    });

    it('keeps nonce state independent per origin', async () => {
        const session = await DpopSession.create();
        session.rememberNonce('https://as.example.com/token', 'as-nonce');
        session.rememberNonce('https://rs.example.com/mcp', 'rs-nonce');
        expect(session.nonceFor('https://as.example.com/token')).toBe('as-nonce');
        expect(session.nonceFor('https://rs.example.com/mcp')).toBe('rs-nonce');
        expect(session.nonceFor('https://other.example.com/x')).toBeUndefined();
    });

    it('supports every DPOP_SUPPORTED_ALGS entry as a construction option', async () => {
        for (const alg of DPOP_SUPPORTED_ALGS) {
            const session = await DpopSession.create({ alg });
            expect(session.alg).toBe(alg);
            const proof = await session.buildProof({ htm: 'GET', htu: 'https://mcp.example.com/mcp' });
            expect(decodeJwtPart(proof.split('.')[0]!).alg).toBe(alg);
        }
    });

    it('reuses a caller-supplied key pair instead of generating a new one', async () => {
        const kp = await generateDpopKeyPair();
        const session = await DpopSession.create({ keyPair: kp });
        expect(session.thumbprint).toBe(kp.thumbprint);
    });
});

describe('DpopSession.observeNonce', () => {
    it('remembers a DPoP-Nonce response header for the given url', async () => {
        const session = await DpopSession.create();
        const url = 'https://mcp.example.com/mcp';
        const response = new Response(null, { headers: { 'DPoP-Nonce': 'fresh-nonce' } });
        session.observeNonce(response, url);
        expect(session.nonceFor(url)).toBe('fresh-nonce');
    });

    it('is a no-op when the response carries no DPoP-Nonce header', async () => {
        const session = await DpopSession.create();
        const url = 'https://mcp.example.com/mcp';
        session.rememberNonce(url, 'existing');
        session.observeNonce(new Response(null), url);
        expect(session.nonceFor(url)).toBe('existing');
    });
});

describe('isDpopNonceChallenge', () => {
    it('is true for a 401 with a DPoP use_dpop_nonce challenge', () => {
        const response = new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce", resource_metadata="https://example.com/prm"' }
        });
        expect(isDpopNonceChallenge(response)).toBe(true);
    });

    it('recognizes a DPoP challenge listed alongside other schemes', () => {
        const response = new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer error="invalid_token", DPoP error="use_dpop_nonce"' }
        });
        expect(isDpopNonceChallenge(response)).toBe(true);
    });

    it('is false for a plain invalid_dpop_proof challenge (not a nonce challenge)', () => {
        const response = new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'DPoP error="invalid_dpop_proof"' }
        });
        expect(isDpopNonceChallenge(response)).toBe(false);
    });

    it('is false for a non-401 status', () => {
        const response = new Response(null, { status: 400, headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' } });
        expect(isDpopNonceChallenge(response)).toBe(false);
    });

    it('is false when there is no WWW-Authenticate header at all', () => {
        expect(isDpopNonceChallenge(new Response(null, { status: 401 }))).toBe(false);
    });

    it('is false for a Bearer-only challenge', () => {
        const response = new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="use_dpop_nonce"' } });
        expect(isDpopNonceChallenge(response)).toBe(false);
    });
});
