export * from './express';
export * from './middleware/hostHeaderValidation';
export * from './middleware/originValidation';

// OAuth Resource-Server glue: bearer-token middleware + PRM/AS metadata router.
export type { BearerAuthMiddlewareOptions } from './auth/bearerAuth';
export { requireBearerAuth } from './auth/bearerAuth';
// DPoP (RFC 9449 / SEP-1932) sender-constrained tokens: same OAuthTokenVerifier as bearer auth
// above, plus proof validation against the request.
export type { DpopAuthMiddlewareOptions } from './auth/dpopAuth';
export { requireDpopAuth } from './auth/dpopAuth';
export type { AuthMetadataOptions } from './auth/metadataRouter';
export { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from './auth/metadataRouter';
export type { OAuthTokenVerifier } from './auth/types';
