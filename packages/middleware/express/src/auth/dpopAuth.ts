import type { DpopAuthOptions } from '@modelcontextprotocol/server';
import { dpopAuthChallengeResponse, OAuthError, OAuthErrorCode, verifyDpopToken } from '@modelcontextprotocol/server';
import type { Request, RequestHandler } from 'express';

/**
 * Options for {@link requireDpopAuth}.
 */
export type DpopAuthMiddlewareOptions = DpopAuthOptions;

/**
 * Reconstruct the external request URL — the value a DPoP proof's `htu` claim must match
 * (RFC 9449 §4.2) — from Express's `req`. `req.originalUrl` (not `req.path`) so a router mounted
 * at a sub-path still yields the URL the client actually targeted; the query string is stripped
 * since `htu` MUST NOT contain one.
 *
 * Trusts `X-Forwarded-Proto`/`-Host` only when Express's own `trust proxy` setting says to
 * (`req.protocol` and `req.hostname` already apply that setting); behind an untrusted proxy this
 * falls back to the raw connection protocol and the `Host` header.
 */
function reconstructRequestUrl(req: Request): string {
    const [pathAndQuery] = req.originalUrl.split('?');
    return `${req.protocol}://${req.get('host')}${pathAndQuery}`;
}

/**
 * Express middleware that requires a valid DPoP-bound token — the `Authorization: DPoP <token>`
 * header plus the accompanying `DPoP` proof header — in the request (RFC 9449 / SEP-1932).
 *
 * The Express adapter over the runtime-neutral core in `@modelcontextprotocol/server`
 * (`verifyDpopToken` / `dpopAuthChallengeResponse` — or `requireDpopAuth` from that package for
 * web-standard `fetch(request)` hosts). The token is validated via the supplied
 * `OAuthTokenVerifier` (shared with `requireBearerAuth` — a verifier that populates `AuthInfo.cnf`
 * works with either), the proof is validated against the request's method and reconstructed URL,
 * and the resulting `AuthInfo` is attached to `req.auth` — read by the MCP Streamable HTTP
 * transport and surfaced to handlers as `ctx.http.authInfo`, exactly as `requireBearerAuth`
 * attaches it.
 *
 * On failure the middleware sends a JSON OAuth error body and a `WWW-Authenticate: DPoP …`
 * challenge (plus a `DPoP-Nonce` header when `options.nonce` issues one) — see
 * {@link dpopAuthChallengeResponse} in `@modelcontextprotocol/server`.
 */
export function requireDpopAuth(options: DpopAuthMiddlewareOptions): RequestHandler {
    // Destructure at creation so a plain-JS caller passing undefined or malformed options crashes
    // at startup, not on the first request.
    const { verifier, requiredScopes = [], resourceMetadataUrl, iatSkewSeconds, nonce } = options;
    const resolved = { verifier, requiredScopes, resourceMetadataUrl, iatSkewSeconds, nonce };
    return async (req, res, next) => {
        try {
            req.auth = await verifyDpopToken(
                {
                    authorization: req.headers.authorization,
                    dpop: req.headers.dpop,
                    method: req.method,
                    url: reconstructRequestUrl(req)
                },
                resolved
            );
            next();
        } catch (error) {
            // The core Response supplies status and challenge headers; the body is derived
            // directly rather than parsed back out of the Response.
            const response = dpopAuthChallengeResponse(error, resolved);
            const challenge = response.headers.get('WWW-Authenticate');
            if (challenge !== null) {
                res.set('WWW-Authenticate', challenge);
            }
            const dpopNonce = response.headers.get('DPoP-Nonce');
            if (dpopNonce !== null) {
                res.set('DPoP-Nonce', dpopNonce);
            }
            const body = error instanceof OAuthError ? error : new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
            res.status(response.status).json(body.toResponseObject());
        }
    };
}
