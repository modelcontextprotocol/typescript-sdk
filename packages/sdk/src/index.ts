// Root barrel for @modelcontextprotocol/sdk — the everything package.
//
// Re-exports the full public surface of the server, client, and node packages
// so consumers can `import { McpServer, Client, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk'`
// without choosing a sub-package.
//
// Bundle-sensitive consumers (browser, Workers) should import from
// @modelcontextprotocol/client or @modelcontextprotocol/server directly instead.

// Server gives us all server-specific exports + the entire core/public surface
// (spec types, error classes, transport interface, constants, guards).
export * from '@modelcontextprotocol/server';

// Node middleware — explicit named exports only. Not `export *`, because the
// node package re-exports core types from server and `export *` from both
// packages would collide on overlapping symbols (TS2308).
export { NodeStreamableHTTPServerTransport, type StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/node';
/** @deprecated Renamed to {@linkcode NodeStreamableHTTPServerTransport}. */
export { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from '@modelcontextprotocol/node';

// Client-specific exports only — NOT `export *`, because client also re-exports
// core/public and the duplicate runtime-value identities (each package bundles
// core separately) trigger TS2308. core/public is already covered by server above.
export type {
    AddClientAuthentication,
    AssertionCallback,
    AuthProvider,
    AuthResult,
    ClientAuthMethod,
    ClientCredentialsProviderOptions,
    ClientOptions,
    CrossAppAccessContext,
    CrossAppAccessProviderOptions,
    DiscoverAndRequestJwtAuthGrantOptions,
    JwtAuthGrantResult,
    LoggingOptions,
    Middleware,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthServerInfo,
    PrivateKeyJwtProviderOptions,
    ReconnectionScheduler,
    RequestJwtAuthGrantOptions,
    RequestLogger,
    SSEClientTransportOptions,
    StartSSEOptions,
    StaticPrivateKeyJwtProviderOptions,
    StreamableHTTPClientTransportOptions,
    StreamableHTTPReconnectionOptions
} from '@modelcontextprotocol/client';
export {
    applyMiddlewares,
    auth,
    buildDiscoveryUrls,
    Client,
    ClientCredentialsProvider,
    createMiddleware,
    createPrivateKeyJwtAuth,
    CrossAppAccessProvider,
    discoverAndRequestJwtAuthGrant,
    discoverAuthorizationServerMetadata,
    discoverOAuthMetadata,
    discoverOAuthProtectedResourceMetadata,
    discoverOAuthServerInfo,
    exchangeAuthorization,
    exchangeJwtAuthGrant,
    ExperimentalClientTasks,
    extractResourceMetadataUrl,
    extractWWWAuthenticateParams,
    fetchToken,
    getSupportedElicitationModes,
    isHttpsUrl,
    parseErrorResponse,
    prepareAuthorizationCodeRequest,
    PrivateKeyJwtProvider,
    refreshAuthorization,
    registerClient,
    requestJwtAuthorizationGrant,
    selectClientAuthMethod,
    selectResourceURL,
    SSEClientTransport,
    SseError,
    startAuthorization,
    StaticPrivateKeyJwtProvider,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    validateClientMetadataUrl,
    withLogging,
    withOAuth
} from '@modelcontextprotocol/client';
export type { StdioServerParameters } from '@modelcontextprotocol/client/stdio';
export { DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
