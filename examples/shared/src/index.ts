// Auth configuration
export type { CreateDemoAuthOptions, DemoAuth } from './auth.js';
export { createDemoAuth } from './auth.js';

// Auth middleware
export type { RequireBearerAuthOptions } from './authMiddleware.js';
export { getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from './authMiddleware.js';

// Auth server setup
export type { SetupAuthServerOptions } from './authServer.js';
export { createProtectedResourceMetadataRouter, getAuth, setupAuthServer, verifyAccessToken } from './authServer.js';
