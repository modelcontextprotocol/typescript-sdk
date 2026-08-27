/**
 * DPoP (Demonstrating Proof of Possession) proof validation — the resource-server half of
 * {@link https://datatracker.ietf.org/doc/html/rfc9449 | RFC 9449}, adopted by MCP as the draft
 * extension {@link https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/dpop-extension.mdx | SEP-1932}.
 *
 * Implemented from scratch against RFC 9449 §4.3 using only Web Crypto (`crypto.subtle`), so
 * `@modelcontextprotocol/server` gains no new dependency and this stays usable in any runtime
 * that implements the Web Crypto API (Node ≥20, browsers, edge/worker runtimes) — deliberately an
 * independent code path from the client-side proof builder in `@modelcontextprotocol/client`,
 * rather than a shared module, so a bug in one is unlikely to be mirrored in the other.
 */

// Type-only: borrows the WebCrypto algorithm-parameter shapes Node's ambient types declare
// under `node:crypto`'s `webcrypto` namespace. Erased at build time (no runtime import of
// `node:crypto`) — the actual code below calls only the WHATWG `crypto.subtle` global, which
// every runtime targeted here (Node ≥20, browsers, edge/worker runtimes) implements.
import type { webcrypto } from 'node:crypto';

import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';

/** Asymmetric JWS algorithms a DPoP proof may be signed with (RFC 9449 §11.6 forbids `none` and symmetric algs). */
export const DPOP_SUPPORTED_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'EdDSA'] as const;

/** A DPoP JWS algorithm this SDK can verify proofs signed with. */
export type DpopAlg = (typeof DPOP_SUPPORTED_ALGS)[number];

/** Minimal JWK shape this module reads — not a full RFC 7517 type, only the members DPoP proof verification and thumbprinting need. */
export interface DpopJwk {
    kty?: unknown;
    crv?: unknown;
    x?: unknown;
    y?: unknown;
    n?: unknown;
    e?: unknown;
    k?: unknown;
    d?: unknown;
}

function invalidProof(message: string): OAuthError {
    return new OAuthError(OAuthErrorCode.InvalidDpopProof, message);
}

function base64UrlDecode(input: string): Uint8Array {
    const binary = atob(input.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
    return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Compute the `ath` claim for a DPoP proof presented alongside an access token: the
 * base64url-encoded SHA-256 digest of the ASCII access-token value (RFC 9449 §4.1).
 */
export async function accessTokenHash(accessToken: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
    return base64UrlEncode(new Uint8Array(digest));
}

/**
 * RFC 7638 JWK SHA-256 thumbprint: SHA-256 over the JSON serialization of exactly the key type's
 * required members, included with no whitespace and in the lexicographic member order RFC 7638
 * §3.2 (and RFC 8037 §2 for OKP) mandates. `Object.fromEntries`/object-literal insertion order
 * matches that order for every branch below, so `JSON.stringify` emits the fields correctly
 * without a separate sort step.
 */
export async function calculateJwkThumbprint(jwk: DpopJwk): Promise<string> {
    let members: Record<string, unknown>;
    switch (jwk.kty) {
        case 'EC': {
            members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
            break;
        }
        case 'RSA': {
            members = { e: jwk.e, kty: jwk.kty, n: jwk.n };
            break;
        }
        case 'OKP': {
            members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
            break;
        }
        case 'oct': {
            members = { k: jwk.k, kty: jwk.kty };
            break;
        }
        default: {
            throw invalidProof(`unsupported JWK key type: ${String(jwk.kty)}`);
        }
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(members)));
    return base64UrlEncode(new Uint8Array(digest));
}

interface ParsedDpopJwt {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    signingInput: string;
    signature: Uint8Array;
}

function decodeJwtJsonSegment(segment: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
    } catch {
        throw invalidProof('DPoP proof is not a well-formed JWT');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw invalidProof('DPoP proof is not a well-formed JWT');
    }
    return parsed as Record<string, unknown>;
}

function parseDpopJwt(token: string): ParsedDpopJwt {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => part.length === 0)) {
        throw invalidProof('DPoP proof is not a well-formed JWT');
    }
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
    return {
        header: decodeJwtJsonSegment(headerSegment),
        payload: decodeJwtJsonSegment(payloadSegment),
        signingInput: `${headerSegment}.${payloadSegment}`,
        signature: base64UrlDecode(signatureSegment)
    };
}

/** WebCrypto `importKey`/`verify` parameters for a DPoP JWS algorithm (RFC 9449 §4.3 step 6). */
function webCryptoParams(
    alg: DpopAlg,
    jwk: DpopJwk
): {
    importParams: webcrypto.AlgorithmIdentifier | webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams;
    verifyParams: webcrypto.AlgorithmIdentifier | webcrypto.EcdsaParams | webcrypto.RsaPssParams;
} {
    switch (alg) {
        case 'ES256': {
            return { importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' } };
        }
        case 'ES384': {
            return { importParams: { name: 'ECDSA', namedCurve: 'P-384' }, verifyParams: { name: 'ECDSA', hash: 'SHA-384' } };
        }
        case 'ES512': {
            return { importParams: { name: 'ECDSA', namedCurve: 'P-521' }, verifyParams: { name: 'ECDSA', hash: 'SHA-512' } };
        }
        case 'RS256': {
            return { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } };
        }
        case 'RS384': {
            return { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } };
        }
        case 'RS512': {
            return { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' } };
        }
        case 'PS256': {
            return { importParams: { name: 'RSA-PSS', hash: 'SHA-256' }, verifyParams: { name: 'RSA-PSS', saltLength: 32 } };
        }
        case 'PS384': {
            return { importParams: { name: 'RSA-PSS', hash: 'SHA-384' }, verifyParams: { name: 'RSA-PSS', saltLength: 48 } };
        }
        case 'PS512': {
            return { importParams: { name: 'RSA-PSS', hash: 'SHA-512' }, verifyParams: { name: 'RSA-PSS', saltLength: 64 } };
        }
        case 'EdDSA': {
            // WebCrypto has no generic "EdDSA" algorithm name; the curve (from the JWK's own
            // `crv`) selects Ed25519 or Ed448 (RFC 8037 §3.1 / §3.2).
            const name = jwk.crv === 'Ed448' ? 'Ed448' : 'Ed25519';
            return { importParams: { name }, verifyParams: { name } };
        }
    }
}

/**
 * Verify a JWS signature over `signingInput` using the public key embedded in `jwk`, for one of
 * {@linkcode DPOP_SUPPORTED_ALGS}. Any failure — unsupported key shape, a runtime lacking the
 * algorithm, or a genuine bad signature — resolves to `false` rather than throwing, so a caller
 * always gets a clean reject instead of having to distinguish infrastructure errors from forged
 * proofs.
 */
async function verifyJwsSignature(alg: DpopAlg, jwk: DpopJwk, signingInput: string, signature: Uint8Array): Promise<boolean> {
    const { importParams, verifyParams } = webCryptoParams(alg, jwk);
    try {
        const key = await crypto.subtle.importKey('jwk', jwk as webcrypto.JsonWebKey, importParams, false, ['verify']);
        return await crypto.subtle.verify(verifyParams, key, signature, new TextEncoder().encode(signingInput));
    } catch {
        return false;
    }
}

/**
 * Canonicalize an `htu` for comparison per RFC 9449 §4.3 (RFC 3986 scheme-based normalization):
 * lowercase scheme/host, drop the default port (handled by `URL` itself), tolerate a single
 * trailing slash. Query/fragment are rejected by {@linkcode verifyDpopProof} outright, not
 * silently stripped here.
 */
function normalizeHtu(raw: string): string {
    try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
    } catch {
        return raw;
    }
}

/**
 * Server-provided nonce policy consulted by {@linkcode verifyDpopProof} (RFC 9449 §9). Left
 * entirely to the host — a stateless HMAC-derived nonce, an in-memory set with rotation, or "off"
 * — this module only calls {@linkcode verify}.
 */
export interface DpopNonceState {
    /**
     * Whether `nonce` (the proof's `nonce` claim, or `undefined` if it carried none) is currently
     * acceptable. Return `true` unconditionally to never require a nonce.
     */
    verify(nonce: string | undefined): boolean;
}

export interface VerifyDpopProofOptions {
    /**
     * Raw `DPoP` request header value(s), exactly as the framework adapter read them. Pass an
     * array when the runtime preserves repeated headers separately (RFC 9449 §4.3 step 1
     * requires **exactly one** — an array with more than one entry is rejected, distinctly from a
     * single value that merely *contains* a comma, e.g. Node's `http` module folding repeated
     * headers into one comma-joined string).
     */
    proof: string | string[] | undefined;
    /** HTTP method of the request the proof accompanies (`htm`). Compared case-insensitively. */
    method: string;
    /** HTTP target URI of the request (`htu`) — the full URL the server received the request at. */
    url: string | URL;
    /** When set, the proof's `ath` claim MUST bind to this access token (RFC 9449 §4.3 step 12a). */
    accessToken?: string;
    /** Acceptance window for `iat`, in seconds either side of now. @default 300 (SEP-1932). */
    iatSkewSeconds?: number;
    /** Server-provided nonce requirement (RFC 9449 §9). Omit to not require a nonce. */
    nonce?: DpopNonceState;
}

/** The subset of a verified proof's claims a caller (e.g. replay-protection logic) might need. */
export interface DpopProofClaims {
    jti: string;
    htm: string;
    htu: string;
    iat: number;
    ath?: string;
    nonce?: string;
}

export interface VerifiedDpopProof {
    /** RFC 7638 thumbprint of the proof's public key — compare against the access token's `cnf.jkt` (§4.3 step 12b). */
    jkt: string;
    claims: DpopProofClaims;
}

/**
 * Validate a DPoP proof presented alongside an access token, per RFC 9449 §4.3. Throws an
 * {@linkcode OAuthError} (`invalid_dpop_proof` or, when a nonce is required and missing/wrong,
 * `use_dpop_nonce`) on any failure; {@linkcode server/middleware/dpopAuth.dpopAuthChallengeResponse | dpopAuthChallengeResponse} maps that to the HTTP
 * response.
 *
 * Checks, in RFC 9449 §4.3 order: exactly one well-formed `dpop+jwt` proof header → asymmetric
 * `alg` → `jwk` present with no private-key members → signature verifies against that key →
 * `jti`/`htm`/`htu` present and matching (with `htu` query/fragment rejected outright, not
 * stripped) → `iat` within the acceptance window → `ath` matches the presented token → the
 * server-provided nonce, if required. Does **not** compare the proof key's thumbprint against an
 * access token's `cnf.jkt` — that requires the verified token claims, which only the caller (the
 * `OAuthTokenVerifier`) has; compare the returned {@linkcode VerifiedDpopProof.jkt} yourself (see
 * {@linkcode server/middleware/dpopAuth.verifyDpopToken | verifyDpopToken} for the composed version).
 */
export async function verifyDpopProof(options: VerifyDpopProofOptions): Promise<VerifiedDpopProof> {
    const { proof, method, url, accessToken, iatSkewSeconds = 300, nonce } = options;

    if (proof === undefined) {
        throw invalidProof('missing DPoP proof header');
    }
    if (Array.isArray(proof) && proof.length !== 1) {
        throw invalidProof(proof.length === 0 ? 'missing DPoP proof header' : 'more than one DPoP proof header field');
    }
    const proofValue = Array.isArray(proof) ? proof[0]! : proof;
    // A single header value containing a comma indicates duplicate headers were folded together
    // by the transport (Node's http collapses repeated headers with ", ") — a genuine single
    // proof JWT never contains a comma.
    if (proofValue.includes(',')) {
        throw invalidProof('more than one DPoP proof header field');
    }

    const { header, payload, signingInput, signature } = parseDpopJwt(proofValue);

    if (header.typ !== 'dpop+jwt') {
        throw invalidProof("DPoP proof header 'typ' must be 'dpop+jwt'");
    }
    const alg = header.alg;
    if (typeof alg !== 'string' || !DPOP_SUPPORTED_ALGS.includes(alg as DpopAlg)) {
        throw invalidProof('DPoP proof alg must be a supported asymmetric algorithm');
    }
    const jwk = header.jwk;
    if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) {
        throw invalidProof("DPoP proof header is missing the 'jwk' parameter");
    }
    if ('d' in jwk || 'k' in jwk) {
        throw invalidProof("DPoP proof 'jwk' must not contain a private key");
    }

    const verified = await verifyJwsSignature(alg as DpopAlg, jwk as DpopJwk, signingInput, signature);
    if (!verified) {
        throw invalidProof('DPoP proof signature does not verify');
    }

    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
        throw invalidProof("DPoP proof is missing the 'jti' claim");
    }
    if (typeof payload.htm !== 'string' || payload.htm.toUpperCase() !== method.toUpperCase()) {
        throw invalidProof("DPoP proof 'htm' does not match the request method");
    }
    if (typeof payload.htu !== 'string') {
        throw invalidProof("DPoP proof is missing the 'htu' claim");
    }
    if (payload.htu.includes('?') || payload.htu.includes('#')) {
        throw invalidProof("DPoP proof 'htu' MUST NOT contain a query or fragment (RFC 9449 §4.2)");
    }
    if (normalizeHtu(payload.htu) !== normalizeHtu(url.toString())) {
        throw invalidProof("DPoP proof 'htu' does not match the request URI");
    }
    if (typeof payload.iat !== 'number') {
        throw invalidProof("DPoP proof is missing the 'iat' claim");
    }
    if (Math.abs(Math.floor(Date.now() / 1000) - payload.iat) > iatSkewSeconds) {
        throw invalidProof("DPoP proof 'iat' is outside the acceptance window");
    }

    if (accessToken !== undefined) {
        const expectedAth = await accessTokenHash(accessToken);
        if (payload.ath !== expectedAth) {
            throw invalidProof("DPoP proof 'ath' does not match the presented access token");
        }
    }

    if (nonce && !nonce.verify(typeof payload.nonce === 'string' ? payload.nonce : undefined)) {
        throw new OAuthError(OAuthErrorCode.UseDpopNonce, 'a fresh server-provided nonce is required');
    }

    const jkt = await calculateJwkThumbprint(jwk as DpopJwk);
    return {
        jkt,
        claims: {
            jti: payload.jti,
            htm: payload.htm,
            htu: payload.htu,
            iat: payload.iat,
            ath: typeof payload.ath === 'string' ? payload.ath : undefined,
            nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined
        }
    };
}
