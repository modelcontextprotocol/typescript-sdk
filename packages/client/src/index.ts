// Public API for @modelcontextprotocol/client.
//
// This file defines the complete public surface. It consists of:
//   - Package-specific exports: listed explicitly below (named imports)
//   - Protocol-level types: re-exported from @modelcontextprotocol/core/public
//
// Any new export added here becomes public API. Use named exports, not wildcards.

export type {
    AddClientAuthentication,
    AuthOptions,
    AuthProvider,
    AuthResult,
    ClientAuthMethod,
    OAuthClientInformationContext,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthServerInfo
} from './client/auth.js';
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
    validateAuthorizationResponseIssuer,
    validateClientMetadataUrl
} from './client/auth.js';
export { IssuerMismatchError, OAuthClientFlowError } from './client/authErrors.js';
export type {
    AssertionCallback,
    ClientCredentialsProviderOptions,
    CrossAppAccessContext,
    CrossAppAccessProviderOptions,
    PrivateKeyJwtProviderOptions,
    StaticPrivateKeyJwtProviderOptions
} from './client/authExtensions.js';
export {
    ClientCredentialsProvider,
    createPrivateKeyJwtAuth,
    CrossAppAccessProvider,
    PrivateKeyJwtProvider,
    StaticPrivateKeyJwtProvider
} from './client/authExtensions.js';
export type { CacheableRequestOptions, CallToolRequestOptions, ClientOptions, ConnectOptions, McpSubscription } from './client/client.js';
export { Client } from './client/client.js';
export { getSupportedElicitationModes } from './client/client.js';
export type { DiscoverAndRequestJwtAuthGrantOptions, JwtAuthGrantResult, RequestJwtAuthGrantOptions } from './client/crossAppAccess.js';
export { discoverAndRequestJwtAuthGrant, exchangeJwtAuthGrant, requestJwtAuthorizationGrant } from './client/crossAppAccess.js';
export type { LoggingOptions, Middleware, RequestLogger } from './client/middleware.js';
export { applyMiddlewares, createMiddleware, withLogging, withOAuth } from './client/middleware.js';
export type {
    CacheEntry,
    CacheKey,
    CacheMode,
    CacheScope,
    InMemoryResponseCacheStoreOptions,
    MaybePromise,
    ResponseCacheStore
} from './client/responseCache.js';
export { InMemoryResponseCacheStore, MAX_CACHE_TTL_MS } from './client/responseCache.js';
export type { SSEClientTransportOptions } from './client/sse.js';
export { SSEClientTransport, SseError } from './client/sse.js';
export type { VersionNegotiationMode, VersionNegotiationOptions, VersionNegotiationProbeOptions } from './client/versionNegotiation.js';
// StdioClientTransport, getDefaultEnvironment, DEFAULT_INHERITED_ENV_VARS, StdioServerParameters are exported from
// the './stdio' subpath to keep the root entry free of process-spawning runtime dependencies (child_process, cross-spawn).
export type {
    ReconnectionScheduler,
    StartSSEOptions,
    StreamableHTTPClientTransportOptions,
    StreamableHTTPReconnectionOptions
} from './client/streamableHttp.js';
export { StreamableHTTPClientTransport } from './client/streamableHttp.js';

// runtime-aware wrapper (shadows core/public's fromJsonSchema with optional validator)
export { fromJsonSchema } from './fromJsonSchema.js';

// Multi-round-trip requests (protocol revision 2026-07-28): the client-side
// auto-fulfilment knobs (ClientOptions.inputRequired) and the manual-mode
// schema wrapper for callers that opt out of auto-fulfilment per call.
export type { InputRequiredOptions } from '@modelcontextprotocol/core';
export { withInputRequired } from '@modelcontextprotocol/core';

// re-export curated public API from core
export * from '@modelcontextprotocol/core/public';
