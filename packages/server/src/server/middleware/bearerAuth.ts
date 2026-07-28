import type { AuthInfo } from '@modelcontextprotocol/core-internal';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';

/**
 * Minimal token-verifier interface for MCP servers acting as an OAuth 2.0
 * Resource Server. Implementations introspect or locally validate an access
 * token and return the resulting {@link AuthInfo}, which the serving entry
 * surfaces to MCP request handlers via `ctx.http.authInfo`.
 *
 * This is intentionally narrower than a full OAuth Authorization Server
 * provider — it only covers the verification step a Resource Server needs.
 */
export interface OAuthTokenVerifier {
    /**
     * Verifies an access token and returns information about it.
     *
     * Implementations should throw an {@link OAuthError} with
     * `OAuthErrorCode.InvalidToken` when the token is unknown, revoked, or
     * otherwise invalid; the bearer-auth helpers map that to a `401` with a
     * `WWW-Authenticate` challenge.
     *
     * Note: bearer-auth verification rejects tokens whose
     * `AuthInfo.expiresAt` is unset (matches v1 behavior). Ensure your
     * verifier populates it (e.g. from RFC 7662 introspection `exp` or the
     * JWT `exp` claim).
     */
    verifyAccessToken(token: string): Promise<AuthInfo>;
}

/**
 * Options for {@link verifyBearerToken}, {@link requireBearerAuth}, and
 * {@link bearerAuthChallengeResponse}.
 */
export interface BearerAuthOptions {
    /**
     * A verifier used to validate access tokens.
     */
    verifier: OAuthTokenVerifier;

    /**
     * Optional scopes that the token must have. When any are missing the
     * request is refused with `403 insufficient_scope`.
     */
    requiredScopes?: string[];

    /**
     * Optional Protected Resource Metadata URL to advertise in the
     * `WWW-Authenticate` header on 401/403 responses, per
     * {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728}.
     *
     * Typically built with `getOAuthProtectedResourceMetadataUrl`, exported
     * from this package.
     */
    resourceMetadataUrl?: string;
}

function headerQuotedValue(value: string): string {
    // HTTP quoted-string per RFC 7235: escape backslash and double quote, and
    // replace characters a header cannot carry (controls, anything beyond
    // printable ASCII) so a verifier-authored message can never make the
    // challenge Response constructor throw.
    return value.replaceAll(/[\\"]/g, String.raw`\$&`).replaceAll(/[^\u0020-\u007E]/g, ' ');
}

function buildWwwAuthenticateHeader(
    errorCode: string,
    description: string,
    requiredScopes: string[],
    resourceMetadataUrl: string | undefined
): string {
    let header = `Bearer error="${headerQuotedValue(errorCode)}", error_description="${headerQuotedValue(description)}"`;
    if (requiredScopes.length > 0) {
        header += `, scope="${requiredScopes.join(' ')}"`;
    }
    if (resourceMetadataUrl) {
        header += `, resource_metadata="${resourceMetadataUrl}"`;
    }
    return header;
}

/**
 * Validate a raw `Authorization` header value as a Bearer token and return
 * the verified {@link AuthInfo}.
 *
 * The runtime-neutral core of Bearer authentication: it parses the header,
 * runs the verifier, enforces `requiredScopes`, and rejects tokens without an
 * expiration or past it. On any failure it throws an {@link OAuthError} —
 * pass that to {@link bearerAuthChallengeResponse} for the matching HTTP
 * answer, or use {@link requireBearerAuth} to get both steps as one call.
 *
 * Framework adapters build on this: `requireBearerAuth` from
 * `@modelcontextprotocol/express` feeds it `req.headers.authorization`.
 */
export async function verifyBearerToken(authorizationHeader: string | null | undefined, options: BearerAuthOptions): Promise<AuthInfo> {
    const { verifier, requiredScopes = [] } = options;

    if (!authorizationHeader) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Missing Authorization header');
    }

    const [type, token] = authorizationHeader.split(' ');
    if (type?.toLowerCase() !== 'bearer' || !token) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid Authorization header format, expected 'Bearer TOKEN'");
    }

    const authInfo = await verifier.verifyAccessToken(token);

    // Check if token has the required scopes (if any)
    if (requiredScopes.length > 0) {
        const hasAllScopes = requiredScopes.every(scope => authInfo.scopes.includes(scope));
        if (!hasAllScopes) {
            throw new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope');
        }
    }

    // Check if the token is set to expire or if it is expired
    if (typeof authInfo.expiresAt !== 'number' || Number.isNaN(authInfo.expiresAt)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has no expiration time');
    } else if (authInfo.expiresAt < Date.now() / 1000) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has expired');
    }

    return authInfo;
}

/**
 * Build the HTTP answer for a Bearer authentication failure.
 *
 * Maps an {@link OAuthError} to its status — `401` for `invalid_token` and
 * `403` for `insufficient_scope` (both carrying the `WWW-Authenticate: Bearer …`
 * challenge, with `resource_metadata` when configured so clients can discover
 * the Authorization Server), `500` for `server_error`, `400` for anything
 * else. A non-`OAuthError` value answers `500 server_error`. The body is the
 * OAuth error JSON.
 */
export function bearerAuthChallengeResponse(
    error: unknown,
    options?: Pick<BearerAuthOptions, 'requiredScopes' | 'resourceMetadataUrl'>
): Response {
    const { requiredScopes = [], resourceMetadataUrl } = options ?? {};

    if (!(error instanceof OAuthError)) {
        const serverError = new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
        return Response.json(serverError.toResponseObject(), { status: 500 });
    }

    switch (error.code) {
        case OAuthErrorCode.InvalidToken: {
            const challenge = buildWwwAuthenticateHeader(error.code, error.message, requiredScopes, resourceMetadataUrl);
            return Response.json(error.toResponseObject(), { status: 401, headers: { 'WWW-Authenticate': challenge } });
        }
        case OAuthErrorCode.InsufficientScope: {
            const challenge = buildWwwAuthenticateHeader(error.code, error.message, requiredScopes, resourceMetadataUrl);
            return Response.json(error.toResponseObject(), { status: 403, headers: { 'WWW-Authenticate': challenge } });
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
 * Require a valid Bearer token on web-standard requests.
 *
 * The framework-free counterpart of `requireBearerAuth` from
 * `@modelcontextprotocol/express`, for hosts whose HTTP surface is a
 * `fetch(request)` handler — Cloudflare Workers, Deno, Bun, Hono. The
 * returned gate resolves to the verified {@link AuthInfo}, or to the
 * ready-to-return challenge `Response` when the request must be refused.
 *
 * @example
 * ```ts source="./bearerAuth.examples.ts#requireBearerAuth_fetchGate"
 * const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });
 *
 * async function fetchHandler(request: Request): Promise<Response> {
 *     const auth: AuthInfo | Response = await gate(request);
 *     if (auth instanceof Response) return auth;
 *     return handler.fetch(request, { authInfo: auth });
 * }
 * ```
 */
export function requireBearerAuth(options: BearerAuthOptions): (request: Request) => Promise<AuthInfo | Response> {
    // Destructure at creation so a plain-JS caller passing undefined or
    // malformed options crashes at startup, not on the first request.
    const { verifier, requiredScopes = [], resourceMetadataUrl } = options;
    const resolved = { verifier, requiredScopes, resourceMetadataUrl };
    return async request => {
        // Outside the try: a wrong-framework misuse (no web-standard Request)
        // should throw loudly, not surface as a 500 challenge. Fetch's
        // Headers.get comma-joins repeated headers where Node keeps the
        // first; take the first segment so both adapters agree (the token68
        // alphabet has no comma, so this is lossless).
        const [authorizationHeader] = (request.headers.get('authorization') ?? '').split(',');
        try {
            return await verifyBearerToken(authorizationHeader || undefined, resolved);
        } catch (error) {
            return bearerAuthChallengeResponse(error, resolved);
        }
    };
}
