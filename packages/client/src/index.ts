// client/auth.ts — public OAuth API (internals are not re-exported)
export type { AddClientAuthentication, AuthResult, OAuthClientProvider } from './client/auth.js';
export { auth, extractWWWAuthenticateParams, UnauthorizedError } from './client/auth.js';

// client/authExtensions.ts
export type {
    ClientCredentialsProviderOptions,
    PrivateKeyJwtProviderOptions,
    StaticPrivateKeyJwtProviderOptions
} from './client/authExtensions.js';
export {
    ClientCredentialsProvider,
    createPrivateKeyJwtAuth,
    PrivateKeyJwtProvider,
    StaticPrivateKeyJwtProvider
} from './client/authExtensions.js';

// client/client.ts
export type { ClientOptions } from './client/client.js';
export { Client } from './client/client.js';

// client/middleware.ts
export type { LoggingOptions, Middleware, RequestLogger } from './client/middleware.js';
export { applyMiddlewares, createMiddleware, withLogging, withOAuth } from './client/middleware.js';

// client/sse.ts
export type { SSEClientTransportOptions } from './client/sse.js';
export { SSEClientTransport, SseError } from './client/sse.js';

// client/stdio.ts
export type { StdioServerParameters } from './client/stdio.js';
export { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment, StdioClientTransport } from './client/stdio.js';

// client/streamableHttp.ts
export type { StartSSEOptions, StreamableHTTPClientTransportOptions, StreamableHTTPReconnectionOptions } from './client/streamableHttp.js';
export { StreamableHTTPClientTransport, StreamableHTTPError } from './client/streamableHttp.js';

// client/websocket.ts
export { WebSocketClientTransport } from './client/websocket.js';

// experimental exports
export { ExperimentalClientTasks } from './experimental/index.js';

// ============================================================================
// Re-exports from @modelcontextprotocol/core
// Only symbols that are part of the public API are listed here.
// Maintained in a single file to avoid duplication across client and server.
// ============================================================================
export * from '@modelcontextprotocol/core/public';
