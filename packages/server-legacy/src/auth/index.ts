// Core router
export type { AuthMetadataOptions, AuthRouterOptions } from './router';
export { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, mcpAuthRouter } from './router';

// Provider interfaces
export type { AuthorizationParams, OAuthServerProvider, OAuthTokenVerifier } from './provider';

// Proxy provider
export type { ProxyEndpoints, ProxyOptions } from './providers/proxyProvider';
export { ProxyOAuthServerProvider } from './providers/proxyProvider';

// Client store
export type { OAuthRegisteredClientsStore } from './clients';

// Handlers
export type { AuthorizationHandlerOptions } from './handlers/authorize';
export { authorizationHandler, redirectUriMatches } from './handlers/authorize';
export { metadataHandler } from './handlers/metadata';
export type { ClientRegistrationHandlerOptions } from './handlers/register';
export { clientRegistrationHandler } from './handlers/register';
export type { RevocationHandlerOptions } from './handlers/revoke';
export { revocationHandler } from './handlers/revoke';
export type { TokenHandlerOptions } from './handlers/token';
export { tokenHandler } from './handlers/token';

// Middleware
export { allowedMethods } from './middleware/allowedMethods';
export type { BearerAuthMiddlewareOptions } from './middleware/bearerAuth';
export { requireBearerAuth } from './middleware/bearerAuth';
export type { ClientAuthenticationMiddlewareOptions } from './middleware/clientAuth';
export { authenticateClient } from './middleware/clientAuth';

// Error classes
export * from './errors';

// Types
export type { AuthInfo } from './types';
