export * from './express.js';
export * from './middleware/hostHeaderValidation.js';

// OAuth Resource-Server glue: bearer-token middleware + PRM/AS metadata router.
export type { BearerAuthMiddlewareOptions } from './auth/bearerAuth.js';
export { requireBearerAuth } from './auth/bearerAuth.js';
export type { AuthMetadataOptions } from './auth/metadataRouter.js';
export { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from './auth/metadataRouter.js';
export type { OAuthTokenVerifier } from './auth/types.js';

// Server Card (SEP-2127) discovery-document router.
export type { ServerCardRouterOptions } from './serverCard.js';
export { mcpServerCardRouter } from './serverCard.js';
