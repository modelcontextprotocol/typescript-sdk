// Core router
export type { AuthMetadataOptions, AuthRouterOptions } from './router.js';
export { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, mcpAuthRouter } from './router.js';

// Provider interfaces
export type { AuthorizationParams, OAuthServerProvider, OAuthTokenVerifier } from './provider.js';

// Proxy provider
export type { ProxyEndpoints, ProxyOptions } from './providers/proxyProvider.js';
export { ProxyOAuthServerProvider } from './providers/proxyProvider.js';

// Client store
export type { OAuthRegisteredClientsStore } from './clients.js';

// Handlers
export type { AuthorizationHandlerOptions } from './handlers/authorize.js';
export { authorizationHandler, redirectUriMatches } from './handlers/authorize.js';
export { metadataHandler } from './handlers/metadata.js';
export type { ClientRegistrationHandlerOptions } from './handlers/register.js';
export { clientRegistrationHandler } from './handlers/register.js';
export type { RevocationHandlerOptions } from './handlers/revoke.js';
export { revocationHandler } from './handlers/revoke.js';
export type { TokenHandlerOptions } from './handlers/token.js';
export { tokenHandler } from './handlers/token.js';

// Middleware
export { allowedMethods } from './middleware/allowedMethods.js';
export type { BearerAuthMiddlewareOptions } from './middleware/bearerAuth.js';
export { requireBearerAuth } from './middleware/bearerAuth.js';
export type { ClientAuthenticationMiddlewareOptions } from './middleware/clientAuth.js';
export { authenticateClient } from './middleware/clientAuth.js';

// Error classes
export * from './errors.js';

// Types
export type { AuthInfo } from './types.js';
