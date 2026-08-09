/**
 * DPoP (RFC 9449 / SEP-1932) authentication gate for MCP servers acting as an OAuth 2.0 Resource
 * Server. Mirrors the shape of `bearerAuth.ts`: {@linkcode verifyDpopToken} validates a request
 * end to end (token + proof, both required), {@linkcode dpopAuthChallengeResponse} maps a failure
 * to the matching HTTP response, and {@linkcode requireDpopAuth} composes both for web-standard
 * `fetch(request)` hosts. Framework adapters (e.g. `@modelcontextprotocol/express`) build on
 * {@linkcode verifyDpopToken} / {@linkcode dpopAuthChallengeResponse} directly.
 */

import type { AuthInfo } from '@modelcontextprotocol/core-internal';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';

import { buildWwwAuthenticateHeader } from './authChallenge';
import type { BearerAuthOptions } from './bearerAuth';
import type { DpopNonceState } from './dpop';
import { DPOP_SUPPORTED_ALGS, verifyDpopProof } from './dpop';

// Re-exported so a `requireDpopAuth` caller building `DpopAuthOptions` doesn't need a second
// import from `./bearerAuth` for the token-verifier type it shares with Bearer auth.
export type { OAuthTokenVerifier } from './bearerAuth';

/** RFC 9449 §5.1: the JWS algorithms this SDK's DPoP validator accepts, advertised in the `algs` challenge parameter. */
const ADVERTISED_ALGS = DPOP_SUPPORTED_ALGS.join(' ');

/**
 * Options for {@linkcode verifyDpopToken}, {@linkcode dpopAuthChallengeResponse}, and
 * {@linkcode requireDpopAuth}.
 */
export interface DpopAuthOptions extends BearerAuthOptions {
    /**
     * Acceptance window for the proof's `iat`, in seconds either side of the server's clock.
     * @default 300 (SEP-1932's recommended ±5 minutes)
     */
    iatSkewSeconds?: number;

    /**
     * Server-provided nonce support (RFC 9449 §9 — a SHOULD, not a MUST). Omit to never require
     * a nonce. When set, {@linkcode dpopAuthChallengeResponse} calls `issue()` to mint the nonce
     * returned in a `use_dpop_nonce` challenge's `DPoP-Nonce` header, and {@linkcode verifyDpopToken}
     * calls `verify()` (via {@linkcode DpopNonceState}) to check a presented proof's nonce.
     */
    nonce?: {
        /** Mint the nonce to include in the next `use_dpop_nonce` challenge. */
        issue(): string;
    } & DpopNonceState;
}

/** A raw incoming request's fields relevant to DPoP validation, framework-neutral. */
export interface DpopRequest {
    /** Raw `Authorization` header value. */
    authorization: string | null | undefined;
    /**
     * Raw `DPoP` header value(s) — see {@linkcode VerifyDpopProofOptions.proof} in `dpop.ts` for
     * why this is `string | string[] | undefined` rather than always a single string.
     */
    dpop: string | string[] | undefined;
    /** HTTP method of the request. */
    method: string;
    /** Full URL the request arrived at — the value the proof's `htu` claim must match. */
    url: string | URL;
}

/**
 * Validate a DPoP-bound request — the `Authorization: DPoP <token>` header and the accompanying
 * `DPoP` proof header, together — and return the verified {@linkcode AuthInfo}.
 *
 * The runtime-neutral core of DPoP authentication, mirroring {@linkcode verifyBearerToken}: parses
 * the `Authorization` header (requiring the `DPoP` scheme, not `Bearer`), runs `options.verifier`,
 * verifies the proof against the request's method/URL via {@linkcode verifyDpopProof}, then checks
 * that the proof key's RFC 7638 thumbprint matches the verified token's `cnf.jkt` (RFC 9449 §4.3
 * step 12b — the actual sender-constraint check; everything upstream of it only confirms the
 * caller holds *some* valid token and *some* well-formed proof, not that they're bound together).
 * Finally enforces `requiredScopes` and token expiry exactly as `verifyBearerToken` does.
 *
 * On any failure throws an {@linkcode OAuthError} — pass that to
 * {@linkcode dpopAuthChallengeResponse} for the matching HTTP answer, or use
 * {@linkcode requireDpopAuth} to get both steps as one call.
 */
export async function verifyDpopToken(request: DpopRequest, options: DpopAuthOptions): Promise<AuthInfo> {
    const { verifier, requiredScopes = [], iatSkewSeconds, nonce } = options;

    if (!request.authorization) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Missing Authorization header');
    }
    const [scheme, token] = request.authorization.split(' ');
    if (scheme?.toLowerCase() !== 'dpop' || !token) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid Authorization header format, expected 'DPoP TOKEN'");
    }

    const authInfo = await verifier.verifyAccessToken(token);

    const { jkt } = await verifyDpopProof({
        proof: request.dpop,
        method: request.method,
        url: request.url,
        accessToken: token,
        iatSkewSeconds,
        nonce
    });

    // RFC 9449 §4.3 step 12b: the proof's key must be the one this token is bound to. A verifier
    // that never populates `cnf.jkt` (does not support DPoP-bound tokens) cannot pass this gate —
    // every token it issues is rejected here rather than silently accepted as unbound.
    if (authInfo.cnf?.jkt !== jkt) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is not bound to this proof key (cnf.jkt mismatch)');
    }

    if (requiredScopes.length > 0) {
        const hasAllScopes = requiredScopes.every(scope => authInfo.scopes.includes(scope));
        if (!hasAllScopes) {
            throw new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope');
        }
    }

    if (typeof authInfo.expiresAt !== 'number' || Number.isNaN(authInfo.expiresAt)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has no expiration time');
    } else if (authInfo.expiresAt < Date.now() / 1000) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has expired');
    }

    return authInfo;
}

/**
 * Build the HTTP answer for a DPoP authentication failure.
 *
 * Maps an {@linkcode OAuthError} to its status — `401` for `invalid_token`/`invalid_dpop_proof`
 * and `use_dpop_nonce` (all carrying a `WWW-Authenticate: DPoP …` challenge advertising the
 * accepted `algs`, plus `resource_metadata` when configured), `403` for `insufficient_scope`,
 * `500` for `server_error`, `400` for anything else. `use_dpop_nonce` additionally carries a fresh
 * `DPoP-Nonce` response header (from `options.nonce.issue()`) for the client to retry with — see
 * RFC 9449 §9. A non-`OAuthError` value answers `500 server_error`. The body is the OAuth error JSON.
 */
export function dpopAuthChallengeResponse(
    error: unknown,
    options?: Pick<DpopAuthOptions, 'requiredScopes' | 'resourceMetadataUrl' | 'nonce'>
): Response {
    const { requiredScopes = [], resourceMetadataUrl, nonce } = options ?? {};

    if (!(error instanceof OAuthError)) {
        const serverError = new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
        return Response.json(serverError.toResponseObject(), { status: 500 });
    }

    const challenge = (): string =>
        buildWwwAuthenticateHeader('DPoP', error.code, error.message, requiredScopes, resourceMetadataUrl, { algs: ADVERTISED_ALGS });

    switch (error.code) {
        case OAuthErrorCode.InvalidToken:
        case OAuthErrorCode.InvalidDpopProof: {
            return Response.json(error.toResponseObject(), { status: 401, headers: { 'WWW-Authenticate': challenge() } });
        }
        case OAuthErrorCode.UseDpopNonce: {
            const headers: Record<string, string> = { 'WWW-Authenticate': challenge() };
            if (nonce) headers['DPoP-Nonce'] = nonce.issue();
            return Response.json(error.toResponseObject(), { status: 401, headers });
        }
        case OAuthErrorCode.InsufficientScope: {
            return Response.json(error.toResponseObject(), { status: 403, headers: { 'WWW-Authenticate': challenge() } });
        }
        case OAuthErrorCode.ServerError: {
            return Response.json(error.toResponseObject(), { status: 500 });
        }
        default: {
            return Response.json(error.toResponseObject(), { status: 400 });
        }
    }
}

/**
 * Require a valid DPoP-bound token on web-standard requests.
 *
 * The framework-free counterpart of `requireDpopAuth` from `@modelcontextprotocol/express`, for
 * hosts whose HTTP surface is a `fetch(request)` handler — edge/serverless runtimes, Deno, Bun,
 * Hono. The returned gate resolves to the verified {@linkcode AuthInfo}, or to the ready-to-return
 * challenge `Response` when the request must be refused.
 *
 * @example
 * ```ts source="./dpopAuth.examples.ts#requireDpopAuth_fetchGate"
 * const gate = requireDpopAuth({ verifier, requiredScopes: ['mcp'] });
 *
 * async function fetchHandler(request: Request): Promise<Response> {
 *     const auth: AuthInfo | Response = await gate(request);
 *     if (auth instanceof Response) return auth;
 *     return handler.fetch(request, { authInfo: auth });
 * }
 * ```
 */
export function requireDpopAuth(options: DpopAuthOptions): (request: Request) => Promise<AuthInfo | Response> {
    // Destructure at creation so a plain-JS caller passing undefined or malformed options crashes
    // at startup, not on the first request.
    const { verifier, requiredScopes = [], resourceMetadataUrl, iatSkewSeconds, nonce } = options;
    const resolved = { verifier, requiredScopes, resourceMetadataUrl, iatSkewSeconds, nonce };
    return async request => {
        // Outside the try: a wrong-framework misuse (no web-standard Request) should throw
        // loudly, not surface as a 500 challenge.
        const [authorization] = (request.headers.get('authorization') ?? '').split(',');
        // Headers.get comma-joins repeated headers (fetch's Headers behavior, unlike Node's
        // `http` which keeps the first) — verifyDpopProof's own comma check catches a genuine
        // duplicate DPoP header this way; a single proof JWT never contains a comma.
        const dpop = request.headers.get('dpop') ?? undefined;
        try {
            return await verifyDpopToken(
                { authorization: authorization || undefined, dpop, method: request.method, url: request.url },
                resolved
            );
        } catch (error) {
            return dpopAuthChallengeResponse(error, resolved);
        }
    };
}
