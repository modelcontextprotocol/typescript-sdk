/**
 * DPoP (Demonstrating Proof of Possession) client support.
 *
 * Implements the client half of {@link https://datatracker.ietf.org/doc/html/rfc9449 | RFC 9449},
 * adopted by MCP as the draft extension
 * {@link https://github.com/modelcontextprotocol/ext-auth/blob/main/specification/draft/dpop-extension.mdx | SEP-1932}.
 * DPoP binds an OAuth access token to a client-held asymmetric key: every request carries a
 * signed proof JWT over the key, so a stolen bearer token alone cannot be replayed elsewhere.
 *
 * This module is opt-in — nothing here runs unless a caller creates a {@linkcode DpopSession}
 * and wires it into {@linkcode OAuthClientProvider.dpop} (see `auth.ts`) or a {@linkcode withDpop}
 * middleware (see `middleware.ts`). Existing Bearer-token flows are unaffected.
 *
 * `jose` is loaded lazily so the (larger) WebCrypto-key-management code path is only pulled in
 * when a caller actually constructs a {@linkcode DpopSession} — mirroring the lazy `jose` import
 * in {@linkcode createPrivateKeyJwtAuth} (`authExtensions.ts`).
 */

import type { CryptoKey, JWK } from 'jose';

/** Asymmetric JWS algorithms usable for a DPoP proof (RFC 9449 §11.6 forbids symmetric algs and `none`). */
export const DPOP_SUPPORTED_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'EdDSA'] as const;

/** A DPoP JWS algorithm this SDK can sign proofs with. */
export type DpopAlg = (typeof DPOP_SUPPORTED_ALGS)[number];

const DEFAULT_DPOP_ALG: DpopAlg = 'ES256';
const DPOP_TYP = 'dpop+jwt';

async function importJose(): Promise<typeof import('jose')> {
    if (globalThis.crypto === undefined) {
        throw new TypeError(
            'crypto is not available, please ensure you have Web Crypto API support for older Node.js versions (see https://github.com/modelcontextprotocol/typescript-sdk#nodejs-web-crypto-globalthiscrypto-compatibility)'
        );
    }
    return import('jose');
}

/** A DPoP signing key pair: the private key signs proofs, the public JWK is embedded in them. */
export interface DpopKeyPair {
    /** Signs proofs. Non-extractable unless {@linkcode GenerateDpopKeyPairOptions.extractable} was set. */
    privateKey: CryptoKey;
    /** Matches {@linkcode publicJwk}; rarely needed directly. */
    publicKey: CryptoKey;
    /** Embedded in each proof's `jwk` header parameter (RFC 9449 §4.2). */
    publicJwk: JWK;
    /** RFC 7638 JWK SHA-256 thumbprint — the value an authorization server binds as the token's `cnf.jkt`. */
    thumbprint: string;
    /** The JWS algorithm this key pair signs with. */
    alg: DpopAlg;
}

export interface GenerateDpopKeyPairOptions {
    /** Signing algorithm. @default 'ES256' */
    alg?: DpopAlg;
    /**
     * Allow the private key to be exported (e.g. for persistence across process restarts).
     *
     * @default false — RFC 9449 §11.1 and §11.7 recommend non-extractable keys (hardware-backed
     * where available) so the private key cannot be exfiltrated by XSS or a compromised dependency.
     * Only set this when the host has its own plan for protecting the exported key material.
     */
    extractable?: boolean;
}

/** Generate an asymmetric DPoP signing key pair. Non-extractable by default (RFC 9449 §11). */
export async function generateDpopKeyPair(options: GenerateDpopKeyPairOptions = {}): Promise<DpopKeyPair> {
    const alg = options.alg ?? DEFAULT_DPOP_ALG;
    const jose = await importJose();
    const { publicKey, privateKey } = await jose.generateKeyPair(alg, { extractable: options.extractable ?? false });
    const publicJwk = await jose.exportJWK(publicKey);
    const thumbprint = await jose.calculateJwkThumbprint(publicJwk, 'sha256');
    return { privateKey, publicKey, publicJwk, thumbprint, alg };
}

/**
 * Compute the `ath` claim for a DPoP proof presented alongside an access token: the
 * base64url-encoded SHA-256 digest of the ASCII access-token value (RFC 9449 §4.1).
 *
 * Uses Web Crypto (`crypto.subtle`) rather than a Node-only hashing API so this stays usable
 * in browser and edge runtimes.
 */
export async function accessTokenHash(accessToken: string): Promise<string> {
    if (globalThis.crypto?.subtle === undefined) {
        throw new TypeError(
            'crypto.subtle is not available, please ensure you have Web Crypto API support for older Node.js versions (see https://github.com/modelcontextprotocol/typescript-sdk#nodejs-web-crypto-globalthiscrypto-compatibility)'
        );
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
    return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Strip the query and fragment from a URL, per RFC 9449 §4.2 (`htu` MUST NOT contain either). */
function stripQueryAndFragment(url: string | URL): string {
    const u = new URL(url.toString());
    return `${u.origin}${u.pathname}`;
}

/** A fresh, cryptographically random `jti` (RFC 9449 §4.2 — MUST be unique per proof). */
function randomJti(): string {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
}

/** Inputs for a single DPoP proof (RFC 9449 §4.2). */
export interface DpopProofRequest {
    /** HTTP method of the target request (`htm` claim). Case-normalized to upper-case. */
    htm: string;
    /** HTTP target URI of the request (`htu` claim) — query/fragment are stripped automatically. */
    htu: string | URL;
    /** When set, binds the proof to this access token via the `ath` claim (RFC 9449 §4.1). */
    accessToken?: string;
    /**
     * Explicit server-provided nonce to embed. When omitted, the session's remembered nonce for
     * `htu`'s origin (if any) is used automatically — see {@linkcode DpopSession.rememberNonce}.
     */
    nonce?: string;
}

/**
 * A DPoP signing identity plus the small amount of state RFC 9449 requires across requests:
 * the key pair and, per origin, the most recently server-supplied nonce (RFC 9449 §8/§9).
 *
 * One `DpopSession` is meant to live for the lifetime of a single OAuth client registration —
 * the token endpoint and the resource server are different origins and get independent nonce
 * slots, so a nonce challenge from one never leaks into proofs sent to the other.
 */
export class DpopSession {
    private readonly nonces = new Map<string, string>();

    private constructor(private readonly keyPair: DpopKeyPair) {}

    /** Create a session with a fresh key pair, or reuse a caller-supplied one. */
    static async create(options: { alg?: DpopAlg; keyPair?: DpopKeyPair } = {}): Promise<DpopSession> {
        const keyPair = options.keyPair ?? (await generateDpopKeyPair({ alg: options.alg }));
        return new DpopSession(keyPair);
    }

    /** RFC 7638 JWK SHA-256 thumbprint of the signing key — matches the token's `cnf.jkt` once bound. */
    get thumbprint(): string {
        return this.keyPair.thumbprint;
    }

    /** The JWS algorithm this session signs proofs with. */
    get alg(): DpopAlg {
        return this.keyPair.alg;
    }

    /** The public JWK embedded in every proof's `jwk` header parameter. */
    get publicJwk(): JWK {
        return this.keyPair.publicJwk;
    }

    /** The remembered nonce for `url`'s origin, if the server has issued one (RFC 9449 §8/§9). */
    nonceFor(url: string | URL): string | undefined {
        return this.nonces.get(new URL(url.toString()).origin);
    }

    /** Record a server-supplied nonce for `url`'s origin (newest-wins, RFC 9449 §8.2). */
    rememberNonce(url: string | URL, nonce: string): void {
        this.nonces.set(new URL(url.toString()).origin, nonce);
    }

    /**
     * Capture a `DPoP-Nonce` response header, if present, for `url`'s origin. RFC 9449 §8.2 says a
     * fresh nonce may ride on *any* response (success or failure), so call this unconditionally
     * after every request, not only on a `use_dpop_nonce` challenge.
     */
    observeNonce(response: Response, url: string | URL): void {
        const nonce = response.headers.get('dpop-nonce');
        if (nonce) this.rememberNonce(url, nonce);
    }

    /**
     * Build a fresh DPoP proof JWT. Always mints a new `jti` — proofs are never cached or reused,
     * since RFC 9449 §4.3 step 9 requires each to be presented at most once.
     */
    async buildProof(request: DpopProofRequest): Promise<string> {
        const jose = await importJose();
        const htu = stripQueryAndFragment(request.htu);
        const nonce = request.nonce ?? this.nonceFor(request.htu);

        const payload: Record<string, unknown> = {
            jti: randomJti(),
            htm: request.htm.toUpperCase(),
            htu,
            iat: Math.floor(Date.now() / 1000)
        };
        if (request.accessToken !== undefined) {
            payload.ath = await accessTokenHash(request.accessToken);
        }
        if (nonce !== undefined) {
            payload.nonce = nonce;
        }

        return new jose.SignJWT(payload)
            .setProtectedHeader({ alg: this.keyPair.alg, typ: DPOP_TYP, jwk: this.keyPair.publicJwk })
            .sign(this.keyPair.privateKey);
    }
}

// RFC 9110 §5.6.2 `tchar` alphabet for auth-scheme and auth-param token parsing.
const TOKEN_CHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

/**
 * Parses a `WWW-Authenticate` header per RFC 9110 §11.6.1 and reports whether any `DPoP`
 * challenge carries an `error` auth-param equal to `use_dpop_nonce` (RFC 9449 §9).
 */
function hasDpopNonceError(wwwAuthenticate: string): boolean {
    const len = wwwAuthenticate.length;
    let i = 0;
    let currentScheme: string | undefined;

    const skipWs = (): void => {
        while (i < len && (wwwAuthenticate[i] === ' ' || wwwAuthenticate[i] === '\t')) i++;
    };

    const readToken = (): string => {
        const start = i;
        while (i < len && TOKEN_CHAR.test(wwwAuthenticate[i]!)) i++;
        return wwwAuthenticate.slice(start, i);
    };

    const readQuotedString = (): string | undefined => {
        i++;
        let value = '';
        while (i < len) {
            const ch = wwwAuthenticate[i]!;
            if (ch === '\\') {
                if (i + 1 >= len) return undefined;
                value += wwwAuthenticate[i + 1]!;
                i += 2;
                continue;
            }
            if (ch === '"') {
                i++;
                return value;
            }
            value += ch;
            i++;
        }
        return undefined;
    };

    while (i < len) {
        skipWs();
        if (i >= len) break;
        if (wwwAuthenticate[i] === ',') {
            i++;
            continue;
        }

        const token = readToken();
        if (token.length === 0) {
            while (i < len && wwwAuthenticate[i] !== ',') i++;
            currentScheme = undefined;
            continue;
        }

        const afterToken = i;
        skipWs();

        if (wwwAuthenticate[i] === '=') {
            i++;
            skipWs();
            let value: string | undefined;
            if (wwwAuthenticate[i] === '"') {
                value = readQuotedString();
                if (value === undefined) return false;
            } else {
                value = readToken();
            }
            if (currentScheme === 'dpop' && token.toLowerCase() === 'error' && value === 'use_dpop_nonce') {
                return true;
            }
            skipWs();
            if (wwwAuthenticate[i] === ',') {
                i++;
            } else if (i < len) {
                while (i < len && wwwAuthenticate[i] !== ',') i++;
                currentScheme = undefined;
            }
            continue;
        }

        // Not followed by `=`: starts a new `auth-scheme` challenge.
        const scheme = token.toLowerCase();
        if (i >= len || wwwAuthenticate[i] === ',') {
            currentScheme = undefined;
            if (wwwAuthenticate[i] === ',') i++;
            continue;
        }
        if (i === afterToken) {
            while (i < len && wwwAuthenticate[i] !== ',') i++;
            currentScheme = undefined;
            continue;
        }

        // Look ahead to distinguish `auth-scheme SP auth-param` from `auth-scheme SP token68`.
        const saved = i;
        const nextToken = readToken();
        skipWs();
        if (nextToken.length > 0 && wwwAuthenticate[i] === '=') {
            i++;
            skipWs();
            if (i < len && (wwwAuthenticate[i] === '"' || TOKEN_CHAR.test(wwwAuthenticate[i]!))) {
                currentScheme = scheme;
                i = saved;
                continue;
            }
        }

        // Token68 challenge (e.g. `Basic dXNlcjpwYXNz==`): consume to the next comma.
        currentScheme = undefined;
        while (i < len && wwwAuthenticate[i] !== ',') i++;
        if (wwwAuthenticate[i] === ',') i++;
    }

    return false;
}

/**
 * Whether `response` is a resource-server `use_dpop_nonce` challenge (RFC 9449 §9): a `401` whose
 * `WWW-Authenticate` header carries a `DPoP` challenge with `error="use_dpop_nonce"`.
 *
 * A conformant retry re-signs the proof with the nonce {@linkcode DpopSession.observeNonce} just
 * captured — never resend the original proof: RFC 9449 §4.2 requires a unique `jti` per proof, and
 * replaying one across the challenge/retry boundary is itself a violation.
 */
export function isDpopNonceChallenge(response: Response): boolean {
    if (response.status !== 401) return false;
    const wwwAuthenticate = response.headers.get('www-authenticate') ?? '';
    return hasDpopNonceError(wwwAuthenticate);
}
