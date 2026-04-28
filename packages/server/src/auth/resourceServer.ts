/**
 * Framework-agnostic helpers for MCP servers acting as an OAuth 2.0 Resource
 * Server (RFC 6750 / RFC 9728). These contain no HTTP-framework dependencies
 * so that adapter packages (`@modelcontextprotocol/express`, `/hono`,
 * `/fastify`, …) can share the same RFC logic and ship thin per-framework
 * middleware on top.
 */

import type { AuthInfo, OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/core/public';

/**
 * Minimal token-verifier interface for MCP servers acting as an OAuth 2.0
 * Resource Server. Implementations introspect or locally validate an access
 * token and return the resulting {@link AuthInfo}, which adapter middleware
 * attaches to the incoming request and surfaces to MCP request handlers via
 * `ctx.http.authInfo`.
 *
 * This is intentionally narrower than a full OAuth Authorization Server
 * provider; it only covers the verification step a Resource Server needs.
 */
export interface OAuthTokenVerifier {
    /**
     * Verifies an access token and returns information about it.
     *
     * Implementations should throw an `OAuthError` with
     * `OAuthErrorCode.InvalidToken` when the token is unknown, revoked, or
     * otherwise invalid; adapter middleware maps that to a 401 with a
     * `WWW-Authenticate` challenge.
     *
     * Note: adapter middleware rejects tokens whose `AuthInfo.expiresAt` is
     * unset (matches v1 behavior). Ensure your verifier populates it (e.g.
     * from RFC 7662 introspection `exp` or the JWT `exp` claim).
     */
    verifyAccessToken(token: string): Promise<AuthInfo>;
}

/**
 * Builds an RFC 6750 `WWW-Authenticate: Bearer …` challenge header value with
 * the supplied OAuth error code/description, optional required scopes, and
 * optional RFC 9728 `resource_metadata` discovery URL.
 *
 * Adapter packages use this to populate the response header on 401/403.
 */
export function buildWwwAuthenticateHeader(
    errorCode: string,
    description: string,
    requiredScopes: readonly string[],
    resourceMetadataUrl: string | undefined
): string {
    let header = `Bearer error="${errorCode}", error_description="${description}"`;
    if (requiredScopes.length > 0) {
        header += `, scope="${requiredScopes.join(' ')}"`;
    }
    if (resourceMetadataUrl) {
        header += `, resource_metadata="${resourceMetadataUrl}"`;
    }
    return header;
}

// Dev-only escape hatch: allow http:// issuer URLs (e.g., for local testing).
const allowInsecureIssuerUrl =
    process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === 'true' || process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === '1';
if (allowInsecureIssuerUrl) {
    // eslint-disable-next-line no-console
    console.warn('MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL is enabled - HTTP issuer URLs are allowed. Do not use in production.');
}

/**
 * Validates an OAuth issuer URL per RFC 8414: HTTPS-only (with a localhost
 * exemption for development), no fragment, no query string. Throws on
 * violation.
 */
export function checkIssuerUrl(issuer: URL): void {
    // RFC 8414 technically does not permit a localhost HTTPS exemption, but it is necessary for local testing.
    if (issuer.protocol !== 'https:' && issuer.hostname !== 'localhost' && issuer.hostname !== '127.0.0.1' && !allowInsecureIssuerUrl) {
        throw new Error('Issuer URL must be HTTPS');
    }
    if (issuer.hash) {
        throw new Error(`Issuer URL must not have a fragment: ${issuer}`);
    }
    if (issuer.search) {
        throw new Error(`Issuer URL must not have a query string: ${issuer}`);
    }
}

/**
 * Framework-agnostic options for building an RFC 9728 Protected Resource
 * Metadata document. Adapter packages extend this with framework-specific
 * fields if needed.
 */
export interface ProtectedResourceMetadataOptions {
    /**
     * Authorization Server metadata (RFC 8414) for the AS this MCP server
     * relies on. Its `issuer` is advertised in `authorization_servers`.
     */
    oauthMetadata: OAuthMetadata;

    /**
     * The public URL of this MCP server, used as the `resource` value.
     */
    resourceServerUrl: URL;

    /**
     * Optional documentation URL advertised as `resource_documentation`.
     */
    serviceDocumentationUrl?: URL;

    /**
     * Optional list of scopes this MCP server understands, advertised as
     * `scopes_supported`.
     */
    scopesSupported?: string[];

    /**
     * Optional human-readable name advertised as `resource_name`.
     */
    resourceName?: string;
}

/**
 * Builds an RFC 9728 Protected Resource Metadata document from the given
 * options. Adapter packages serve this JSON at
 * `/.well-known/oauth-protected-resource[/<path>]`.
 */
export function buildProtectedResourceMetadata(options: ProtectedResourceMetadataOptions): OAuthProtectedResourceMetadata {
    return {
        resource: options.resourceServerUrl.href,
        authorization_servers: [options.oauthMetadata.issuer],
        scopes_supported: options.scopesSupported,
        resource_name: options.resourceName,
        resource_documentation: options.serviceDocumentationUrl?.href
    };
}

/**
 * Builds the RFC 9728 Protected Resource Metadata URL for a given MCP server
 * URL by inserting `/.well-known/oauth-protected-resource` ahead of the path.
 *
 * @example
 * ```ts
 * getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/mcp'))
 * // → 'https://api.example.com/.well-known/oauth-protected-resource/mcp'
 * ```
 */
export function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): string {
    const u = new URL(serverUrl.href);
    const rsPath = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return new URL(`/.well-known/oauth-protected-resource${rsPath}`, u).href;
}
