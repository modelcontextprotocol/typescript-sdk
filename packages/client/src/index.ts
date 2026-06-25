// Public API for @modelcontextprotocol/client.
//
// This file defines the complete public surface. It consists of:
//   - Package-specific exports: listed explicitly below (named imports)
//   - Protocol-level types: re-exported from @modelcontextprotocol/core/public
//
// Any new export added here becomes public API. Use named exports, not wildcards.

export type {
    AddClientAuthentication,
    AuthProvider,
    AuthResult,
    ClientAuthMethod,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthServerInfo
} from './client/auth';
export {
    auth,
    buildDiscoveryUrls,
    discoverAuthorizationServerMetadata,
    discoverOAuthMetadata,
    discoverOAuthProtectedResourceMetadata,
    discoverOAuthServerInfo,
    exchangeAuthorization,
    extractResourceMetadataUrl,
    extractWWWAuthenticateParams,
    fetchToken,
    isHttpsUrl,
    parseErrorResponse,
    prepareAuthorizationCodeRequest,
    refreshAuthorization,
    registerClient,
    selectClientAuthMethod,
    selectResourceURL,
    startAuthorization,
    UnauthorizedError,
    validateClientMetadataUrl
} from './client/auth';
export type {
    AssertionCallback,
    ClientCredentialsProviderOptions,
    CrossAppAccessContext,
    CrossAppAccessProviderOptions,
    PrivateKeyJwtProviderOptions,
    StaticPrivateKeyJwtProviderOptions
} from './client/authExtensions';
export {
    ClientCredentialsProvider,
    createPrivateKeyJwtAuth,
    CrossAppAccessProvider,
    PrivateKeyJwtProvider,
    StaticPrivateKeyJwtProvider
} from './client/authExtensions';
export type { ClientOptions } from './client/client';
export { Client } from './client/client';
export { getSupportedElicitationModes } from './client/client';
export type { DiscoverAndRequestJwtAuthGrantOptions, JwtAuthGrantResult, RequestJwtAuthGrantOptions } from './client/crossAppAccess';
export { discoverAndRequestJwtAuthGrant, exchangeJwtAuthGrant, requestJwtAuthorizationGrant } from './client/crossAppAccess';
export type { LoggingOptions, Middleware, RequestLogger } from './client/middleware';
export { applyMiddlewares, createMiddleware, withLogging, withOAuth } from './client/middleware';
export type { SSEClientTransportOptions } from './client/sse';
export { SSEClientTransport, SseError } from './client/sse';
// StdioClientTransport, getDefaultEnvironment, DEFAULT_INHERITED_ENV_VARS, StdioServerParameters are exported from
// the './stdio' subpath to keep the root entry free of process-spawning runtime dependencies (child_process, cross-spawn).
export type {
    ReconnectionScheduler,
    StartSSEOptions,
    StreamableHTTPClientTransportOptions,
    StreamableHTTPReconnectionOptions
} from './client/streamableHttp';
export { StreamableHTTPClientTransport } from './client/streamableHttp';

// runtime-aware wrapper (shadows core/public's fromJsonSchema with optional validator)
export { fromJsonSchema } from './fromJsonSchema';

// re-export curated public API from core
export * from '@modelcontextprotocol/core/public';
