// Auth configuration
export type { CreateDemoAuthOptions, DemoAuth } from './auth.js';
export { createDemoAuth } from './auth.js';

// Auth middleware
export type { McpAuthMetadataRouterOptions, RequireBearerAuthOptions } from './authMiddleware.js';
export { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from './authMiddleware.js';

// Auth server setup
export type { AuthServerResult, SetupAuthServerOptions } from './authServer.js';
export { getAuth, setupAuthServer, verifyAccessToken } from './authServer.js';
