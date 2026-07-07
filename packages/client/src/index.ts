// Public API for @modelcontextprotocol/client.
//
// This file defines the complete public surface. It consists of:
//   - Package-specific exports: listed explicitly below (named imports)
//   - Protocol-level types: re-exported from @modelcontextprotocol/core-internal/public
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
    OAuthServerInfo,
    ResourceMetadataUrlSource
} from './client/auth';
export {
    assertSecureTokenEndpoint,
    auth,
    buildDiscoveryUrls,
    computeScopeUnion,
    discoverAuthorizationServerMetadata,
    discoverOAuthMetadata,
    discoverOAuthProtectedResourceMetadata,
    discoverOAuthServerInfo,
    exchangeAuthorization,
    extractResourceMetadataUrl,
    extractWWWAuthenticateParams,
    fetchToken,
    isHttpsUrl,
    isStrictScopeSuperset,
    parseErrorResponse,
    prepareAuthorizationCodeRequest,
    refreshAuthorization,
    registerClient,
    resolveClientMetadata,
    selectClientAuthMethod,
    selectResourceURL,
    startAuthorization,
    UnauthorizedError,
    validateAuthorizationResponseIssuer,
    validateClientMetadataUrl
} from './client/auth';
export {
    AuthorizationServerMismatchError,
    InsecureTokenEndpointError,
    InsufficientScopeError,
    IssuerMismatchError,
    OAuthClientFlowError,
    RedirectFilteredResponseError,
    RegistrationRejectedError
} from './client/authErrors';
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
export type { CacheableRequestOptions, CallToolRequestOptions, ClientOptions, ConnectOptions, McpSubscription } from './client/client';
export { Client } from './client/client';
export { getSupportedElicitationModes } from './client/client';
export type { DiscoverAndRequestJwtAuthGrantOptions, JwtAuthGrantResult, RequestJwtAuthGrantOptions } from './client/crossAppAccess';
export { discoverAndRequestJwtAuthGrant, exchangeJwtAuthGrant, requestJwtAuthorizationGrant } from './client/crossAppAccess';
export type { LoggingOptions, Middleware, RequestLogger } from './client/middleware';
export { applyMiddlewares, createMiddleware, withLogging, withOAuth } from './client/middleware';
export type {
    CacheEntry,
    CacheKey,
    CacheMode,
    CacheScope,
    InMemoryResponseCacheStoreOptions,
    MaybePromise,
    ResponseCacheStore
} from './client/responseCache';
export { InMemoryResponseCacheStore, MAX_CACHE_TTL_MS } from './client/responseCache';
export type { SSEClientTransportOptions } from './client/sse';
export { SSEClientTransport, SseError } from './client/sse';
export type { VersionNegotiationMode, VersionNegotiationOptions, VersionNegotiationProbeOptions } from './client/versionNegotiation';
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

// OAuth discovery URL policy (RFC 9728 §3 / §7.6, RFC 8414 §2): the mechanical
// validator the client OAuth flow runs on every network-derived URL, its
// failure type, and the context/option types the
// OAuthClientProvider.validateDiscoveryURL hook is written against. Client-only
// vocabulary, so it is exported here rather than from the shared core-internal
// public barrel (which the server package re-exports).
export type {
    DiscoveryUrlContext,
    DiscoveryUrlPolicyOptions,
    DiscoveryUrlProducer,
    DiscoveryUrlPurpose,
    DiscoveryUrlSource
} from '@modelcontextprotocol/core-internal';
export { assertAllowedDiscoveryUrl, DiscoveryUrlBlockedError } from '@modelcontextprotocol/core-internal';

// Multi-round-trip requests (protocol revision 2026-07-28): the client-side
// auto-fulfilment knobs (ClientOptions.inputRequired) and the manual-mode
// schema wrapper for callers that opt out of auto-fulfilment per call.
export type { InputRequiredOptions } from '@modelcontextprotocol/core-internal';
export { withInputRequired } from '@modelcontextprotocol/core-internal';

// re-export curated public API from core
export * from '@modelcontextprotocol/core-internal/public';
