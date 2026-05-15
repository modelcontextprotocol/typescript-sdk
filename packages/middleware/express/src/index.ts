export * from './express';
export * from './middleware/hostHeaderValidation';

// OAuth Resource-Server glue: bearer-token middleware + PRM/AS metadata router.
export type { BearerAuthMiddlewareOptions } from './auth/bearerAuth';
export { requireBearerAuth } from './auth/bearerAuth';
export type { AuthMetadataOptions } from './auth/metadataRouter';
export { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from './auth/metadataRouter';
export type { OAuthTokenVerifier } from './auth/types';
