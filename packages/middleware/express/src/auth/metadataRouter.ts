import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { RequestHandler, Router } from 'express';
import express from 'express';

// Dev-only escape hatch: allow http:// issuer URLs (e.g., for local testing).
const allowInsecureIssuerUrl =
    process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === 'true' || process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === '1';
if (allowInsecureIssuerUrl) {
    // eslint-disable-next-line no-console
    console.warn('MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL is enabled - HTTP issuer URLs are allowed. Do not use in production.');
}

function checkIssuerUrl(issuer: URL): void {
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
 * Express middleware that rejects HTTP methods not in the supplied allow-list
 * with a 405 Method Not Allowed and an OAuth-style error body. Used by
 * {@link metadataHandler} to restrict metadata endpoints to GET/OPTIONS.
 */
export function allowedMethods(allowed: string[]): RequestHandler {
    return (req, res, next) => {
        if (allowed.includes(req.method)) {
            next();
            return;
        }
        const error = new OAuthError(OAuthErrorCode.MethodNotAllowed, `The method ${req.method} is not allowed for this endpoint`);
        res.status(405).set('Allow', allowed.join(', ')).json(error.toResponseObject());
    };
}

/**
 * Builds a small Express router that serves the given OAuth metadata document
 * at `/` as JSON, with permissive CORS and a GET/OPTIONS method allow-list.
 *
 * Used by {@link mcpAuthMetadataRouter} for both the Authorization Server and
 * Protected Resource metadata endpoints.
 */
export function metadataHandler(metadata: OAuthMetadata | OAuthProtectedResourceMetadata): RequestHandler {
    const router = express.Router();
    // Metadata documents must be fetchable from web-based MCP clients on any origin.
    router.use(cors());
    router.use(allowedMethods(['GET', 'OPTIONS']));
    router.get('/', (_req, res) => {
        res.status(200).json(metadata);
    });
    return router;
}

/**
 * Options for {@link mcpAuthMetadataRouter}.
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
}

/**
 * Builds an Express router that serves the two OAuth discovery documents an
 * MCP server acting purely as a Resource Server needs to expose:
 *
 *  - `/.well-known/oauth-protected-resource[/<path>]` — RFC 9728 Protected
 *    Resource Metadata, derived from the supplied options.
 *  - `/.well-known/oauth-authorization-server` — RFC 8414 Authorization
 *    Server Metadata, passed through verbatim from {@link AuthMetadataOptions.oauthMetadata}.
 *
 * Mount this router at the application root:
 *
 * ```ts
 * app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl }));
 * ```
 *
 * Pair with `requireBearerAuth` on your `/mcp` route and pass
 * `getOAuthProtectedResourceMetadataUrl` as its `resourceMetadataUrl`
 * so unauthenticated clients can discover the AS from the 401 challenge.
 */
export function mcpAuthMetadataRouter(options: AuthMetadataOptions): Router {
    checkIssuerUrl(new URL(options.oauthMetadata.issuer));

    const router = express.Router();

    const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
        resource: options.resourceServerUrl.href,
        authorization_servers: [options.oauthMetadata.issuer],
        scopes_supported: options.scopesSupported,
        resource_name: options.resourceName,
        resource_documentation: options.serviceDocumentationUrl?.href
    };

    // Serve PRM at the path-aware URL per RFC 9728 §3.1.
    const rsPath = new URL(options.resourceServerUrl.href).pathname;
    router.use(`/.well-known/oauth-protected-resource${rsPath === '/' ? '' : rsPath}`, metadataHandler(protectedResourceMetadata));

    // Mirror the AS metadata at this origin for clients that look here first.
    router.use('/.well-known/oauth-authorization-server', metadataHandler(options.oauthMetadata));

    return router;
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
