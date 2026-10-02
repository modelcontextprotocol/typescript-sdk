// Auth + resumability scaffolding for the handful of stories that need it
// (`oauth`, `oauth-client-credentials`, `sse-polling`, `repl`). Kept off the
// root barrel so the other ~25 stories do not eagerly evaluate
// better-auth/express/cors/better-sqlite3 via `parseExampleArgs`.

// Auth configuration
export type { CreateDemoAuthOptions, DemoAuth } from './auth';
export { createDemoAuth } from './auth';

// Auth server setup + demo token verifier (pass to `requireBearerAuth` from @modelcontextprotocol/express)
export type { SetupAuthServerOptions } from './authServer';
export { createProtectedResourceMetadataRouter, demoTokenVerifier, getAuth, setupAuthServer } from './authServer';

// In-memory EventStore for resumability examples (sse-polling, repl)
export { InMemoryEventStore } from './inMemoryEventStore';

// Minimal client_credentials-only AS (machine-to-machine; no browser)
export type { ClientCredentialsAuthServer, ClientCredentialsAuthServerOptions, RegisteredClient } from './clientCredentialsAuthServer';
export { clientCredentialsTokenVerifier, createClientCredentialsAuthServer } from './clientCredentialsAuthServer';
