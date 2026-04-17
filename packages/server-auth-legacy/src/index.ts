/**
 * @packageDocumentation
 *
 * Frozen copy of the v1 SDK's `src/server/auth/` Authorization Server helpers.
 *
 * @deprecated The MCP SDK no longer ships an Authorization Server implementation.
 * This package exists solely to ease migration from `@modelcontextprotocol/sdk` v1
 * and will not receive new features. Use a dedicated OAuth Authorization Server
 * (e.g. an IdP) and the Resource Server helpers in `@modelcontextprotocol/express`
 * instead.
 */

export type { OAuthRegisteredClientsStore } from './clients.js';
export * from './errors.js';
export type { AuthorizationHandlerOptions } from './handlers/authorize.js';
export { authorizationHandler, redirectUriMatches } from './handlers/authorize.js';
export { metadataHandler } from './handlers/metadata.js';
export type { ClientRegistrationHandlerOptions } from './handlers/register.js';
export { clientRegistrationHandler } from './handlers/register.js';
export type { RevocationHandlerOptions } from './handlers/revoke.js';
export { revocationHandler } from './handlers/revoke.js';
export type { TokenHandlerOptions } from './handlers/token.js';
export { tokenHandler } from './handlers/token.js';
export { allowedMethods } from './middleware/allowedMethods.js';
export type { BearerAuthMiddlewareOptions } from './middleware/bearerAuth.js';
export { requireBearerAuth } from './middleware/bearerAuth.js';
export type { ClientAuthenticationMiddlewareOptions } from './middleware/clientAuth.js';
export { authenticateClient } from './middleware/clientAuth.js';
export type { AuthorizationParams, OAuthServerProvider, OAuthTokenVerifier } from './provider.js';
export type { ProxyEndpoints, ProxyOptions } from './providers/proxyProvider.js';
export { ProxyOAuthServerProvider } from './providers/proxyProvider.js';
export type { AuthMetadataOptions, AuthRouterOptions } from './router.js';
export { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, mcpAuthRouter } from './router.js';
export type { AuthInfo } from './types.js';
