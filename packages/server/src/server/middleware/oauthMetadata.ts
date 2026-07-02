import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/core-internal';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';

/**
 * Options for {@link oauthMetadataResponse} and
 * {@link buildOAuthProtectedResourceMetadata}.
 */
export interface AuthMetadataOptions {
    /**
     * Authorization Server metadata (RFC 8414) for the AS this MCP server
     * relies on. Served at `/.well-known/oauth-authorization-server` so
     * legacy clients that probe the resource origin still discover the AS.
     */
    oauthMetadata: OAuthMetadata;

    /**
     * The public URL of this MCP server, used as the `resource` value in the
     * Protected Resource Metadata document. Any path component is reflected
     * in the well-known route per RFC 9728.
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

    /**
     * Allow a non-HTTPS issuer URL. Local testing only — never enable in
     * production. The Express adapter maps its
     * `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL` environment variable here.
     */
    dangerouslyAllowInsecureIssuerUrl?: boolean;
}

function checkIssuerUrl(issuer: URL, allowInsecure: boolean | undefined): void {
    // RFC 8414 technically does not permit a localhost HTTPS exemption, but it is necessary for local testing.
    if (issuer.protocol !== 'https:' && issuer.hostname !== 'localhost' && issuer.hostname !== '127.0.0.1' && !allowInsecure) {
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
 * Derive the RFC 9728 Protected Resource Metadata document from
 * {@link AuthMetadataOptions}, validating the Authorization Server issuer URL
 * (HTTPS required outside localhost) in the process.
 *
 * `oauthMetadataResponse` and the Express `mcpAuthMetadataRouter` both build
 * on this; use it directly when serving the document through your own
 * routing — or call it once at startup to fail fast on a misconfigured
 * issuer before any request arrives.
 */
export function buildOAuthProtectedResourceMetadata(options: AuthMetadataOptions): OAuthProtectedResourceMetadata {
    checkIssuerUrl(new URL(options.oauthMetadata.issuer), options.dangerouslyAllowInsecureIssuerUrl);
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
    return new URL(protectedResourceMetadataPath(serverUrl), serverUrl).href;
}

/** The RFC 9728 path-aware well-known path for a resource URL. */
function protectedResourceMetadataPath(resourceServerUrl: URL): string {
    // Normalized like the request path in `oauthMetadataResponse`: a resource
    // URL with a trailing slash must not make its own PRM route unreachable.
    const rsPath = stripTrailingSlash(resourceServerUrl.pathname);
    return `/.well-known/oauth-protected-resource${rsPath === '/' ? '' : rsPath}`;
}

function stripTrailingSlash(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

function metadataDocumentResponse(request: Request, metadata: OAuthMetadata | OAuthProtectedResourceMetadata): Response {
    // Metadata documents must be fetchable from web-based MCP clients on any
    // origin, so every response carries permissive CORS headers.
    if (request.method === 'OPTIONS') {
        const requestedHeaders = request.headers.get('access-control-request-headers');
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': ALLOWED_METHODS,
                // The reflected allow-list makes the response vary by request:
                // without this a shared cache would replay one preflight's
                // allow-list against another's headers.
                ...(requestedHeaders === null
                    ? {}
                    : { 'Access-Control-Allow-Headers': requestedHeaders, Vary: 'Access-Control-Request-Headers' })
            }
        });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        const error = new OAuthError(OAuthErrorCode.MethodNotAllowed, `The method ${request.method} is not allowed for this endpoint`);
        return Response.json(error.toResponseObject(), {
            status: 405,
            headers: { Allow: ALLOWED_METHODS, 'Access-Control-Allow-Origin': '*' }
        });
    }
    const response = Response.json(metadata, { headers: { 'Access-Control-Allow-Origin': '*' } });
    // RFC 9110: HEAD is GET without the body, same headers.
    return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

/**
 * Serve the two OAuth discovery documents an MCP server acting as a Resource
 * Server exposes, from a web-standard `fetch(request)` handler:
 *
 *  - `/.well-known/oauth-protected-resource[/<path>]` — RFC 9728 Protected
 *    Resource Metadata, derived from the supplied options (path-aware: the
 *    resource URL's path is reflected in the route).
 *  - `/.well-known/oauth-authorization-server` — RFC 8414 Authorization
 *    Server Metadata, passed through verbatim.
 *
 * Returns the matched document `Response` (JSON with permissive CORS, `405`
 * with an `Allow` header for non-GET methods, `204` for CORS preflight), or
 * `undefined` when the request path is neither well-known route — fall
 * through to your own routing. The framework-free counterpart of
 * `mcpAuthMetadataRouter` from `@modelcontextprotocol/express`; pair it with
 * `requireBearerAuth` and `getOAuthProtectedResourceMetadataUrl` so
 * unauthenticated clients can discover the AS from the `401` challenge.
 *
 * @example
 * ```ts source="./oauthMetadata.examples.ts#oauthMetadataResponse_fetchHandler"
 * async function fetchHandler(request: Request): Promise<Response> {
 *     return oauthMetadataResponse(request, options) ?? serveMcp(request);
 * }
 * ```
 */
export function oauthMetadataResponse(request: Request, options: AuthMetadataOptions): Response | undefined {
    // Match before building: unmatched traffic must fall through untouched,
    // even when the options are misconfigured — a bad issuer surfaces on the
    // discovery routes (or at startup via buildOAuthProtectedResourceMetadata),
    // never on the host's own traffic.
    // Tolerate a single trailing slash, as path-mounted routers do.
    const requestPath = stripTrailingSlash(new URL(request.url).pathname);
    if (requestPath === protectedResourceMetadataPath(options.resourceServerUrl)) {
        return metadataDocumentResponse(request, buildOAuthProtectedResourceMetadata(options));
    }
    if (requestPath === '/.well-known/oauth-authorization-server') {
        buildOAuthProtectedResourceMetadata(options); // issuer validation
        return metadataDocumentResponse(request, options.oauthMetadata);
    }
    return undefined;
}
