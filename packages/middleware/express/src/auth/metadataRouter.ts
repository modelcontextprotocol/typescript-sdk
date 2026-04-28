import type { OAuthMetadata, OAuthProtectedResourceMetadata, ProtectedResourceMetadataOptions } from '@modelcontextprotocol/server';
import { buildProtectedResourceMetadata, checkIssuerUrl, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { RequestHandler, Router } from 'express';
import express from 'express';

// Re-exported for backwards compatibility; canonical home is @modelcontextprotocol/server.
export { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';

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
 * Options for {@link mcpAuthMetadataRouter}. Same shape as the
 * framework-agnostic {@link ProtectedResourceMetadataOptions} from
 * `@modelcontextprotocol/server`; the `oauthMetadata` is also served verbatim
 * at `/.well-known/oauth-authorization-server` so legacy clients that probe
 * the resource origin still discover the AS.
 */
export type AuthMetadataOptions = ProtectedResourceMetadataOptions;

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

    const protectedResourceMetadata = buildProtectedResourceMetadata(options);

    // Serve PRM at the path-aware URL per RFC 9728 §3.1.
    const rsPath = new URL(options.resourceServerUrl.href).pathname;
    router.use(`/.well-known/oauth-protected-resource${rsPath === '/' ? '' : rsPath}`, metadataHandler(protectedResourceMetadata));

    // Mirror the AS metadata at this origin for clients that look here first.
    router.use('/.well-known/oauth-authorization-server', metadataHandler(options.oauthMetadata));

    return router;
}
