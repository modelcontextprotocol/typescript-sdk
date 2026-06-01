// Auth configuration
export type { CreateDemoAuthOptions, DemoAuth } from './auth.js';
export { createDemoAuth } from './auth.js';

// Auth server setup + demo token verifier (pass to `requireBearerAuth` from @modelcontextprotocol/express)
export type { SetupAuthServerOptions } from './authServer.js';
export { createProtectedResourceMetadataRouter, demoTokenVerifier, getAuth, setupAuthServer } from './authServer.js';
