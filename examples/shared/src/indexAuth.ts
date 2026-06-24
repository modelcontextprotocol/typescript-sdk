// Auth + resumability scaffolding for the handful of stories that need it
// (`oauth`, `oauth-client-credentials`, `sse-polling`, `repl`). Kept off the
// root barrel so the other ~25 stories do not eagerly evaluate
// better-auth/express/cors/better-sqlite3 via `parseExampleArgs`.

// Auth configuration
export type { CreateDemoAuthOptions, DemoAuth } from './auth.js';
export { createDemoAuth } from './auth.js';

// Auth server setup + demo token verifier (pass to `requireBearerAuth` from @modelcontextprotocol/express)
export type { SetupAuthServerOptions } from './authServer.js';
export { createProtectedResourceMetadataRouter, demoTokenVerifier, getAuth, setupAuthServer } from './authServer.js';

// In-memory EventStore for resumability examples (sse-polling, repl)
export { InMemoryEventStore } from './inMemoryEventStore.js';

// Minimal client_credentials-only AS (machine-to-machine; no browser)
export type { ClientCredentialsAuthServer, ClientCredentialsAuthServerOptions, RegisteredClient } from './clientCredentialsAuthServer.js';
export { clientCredentialsTokenVerifier, createClientCredentialsAuthServer } from './clientCredentialsAuthServer.js';
