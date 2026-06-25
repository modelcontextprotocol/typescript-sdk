// Auth configuration
export type { CreateDemoAuthOptions, DemoAuth } from './auth';
export { createDemoAuth } from './auth';

// Auth server setup + demo token verifier (pass to `requireBearerAuth` from @modelcontextprotocol/express)
export type { SetupAuthServerOptions } from './authServer';
export { createProtectedResourceMetadataRouter, demoTokenVerifier, getAuth, setupAuthServer } from './authServer';
