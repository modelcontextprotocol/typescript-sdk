// Public API for @modelcontextprotocol/server.
//
// This file defines the complete public surface. It consists of:
//   - Package-specific exports: listed explicitly below (named imports)
//   - Protocol-level types: re-exported from @modelcontextprotocol/core-internal/public
//
// Any new export added here becomes public API. Use named exports, not wildcards.

export type { CompletableSchema, CompleteCallback } from './server/completable';
export { completable, isCompletable } from './server/completable';
export type {
    CreateMcpHandlerOptions,
    LegacyHttpHandler,
    McpHandlerRequestOptions,
    McpHttpHandler,
    McpRequestContext,
    McpServerFactory
} from './server/createMcpHandler';
export { createMcpHandler, isLegacyRequest, legacyStatelessFallback } from './server/createMcpHandler';
export type {
    AnyToolHandler,
    BaseToolCallback,
    CallToolResultWithStructuredContent,
    CompleteResourceTemplateCallback,
    ListResourcesCallback,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceTemplateCallback,
    RegisteredPrompt,
    RegisteredResource,
    RegisteredResourceTemplate,
    RegisteredTool,
    ResourceMetadata,
    ToolCallback
} from './server/mcp';
export { McpServer, ResourceTemplate } from './server/mcp';
// Runtime-neutral Bearer authentication for web-standard hosts; the Express
// middleware in @modelcontextprotocol/express adapts the same core.
export type { BearerAuthOptions, OAuthTokenVerifier } from './server/middleware/bearerAuth';
export { bearerAuthChallengeResponse, requireBearerAuth, verifyBearerToken } from './server/middleware/bearerAuth';
export type { HostHeaderValidationResult } from './server/middleware/hostHeaderValidation';
export { hostHeaderValidationResponse, localhostAllowedHostnames, validateHostHeader } from './server/middleware/hostHeaderValidation';
// OAuth discovery documents (RFC 9728 / RFC 8414) for web-standard hosts; the
// Express metadata router in @modelcontextprotocol/express adapts the same core.
export type { AuthMetadataOptions } from './server/middleware/oauthMetadata';
export {
    buildOAuthProtectedResourceMetadata,
    getOAuthProtectedResourceMetadataUrl,
    oauthMetadataResponse
} from './server/middleware/oauthMetadata';
export type { OriginValidationResult } from './server/middleware/originValidation';
export { localhostAllowedOrigins, originValidationResponse, validateOriginHeader } from './server/middleware/originValidation';
export type { PerRequestHTTPServerTransportOptions, PerRequestMessageExtra, PerRequestResponseMode } from './server/perRequestTransport';
export { PerRequestHTTPServerTransport } from './server/perRequestTransport';
// Opt-in HMAC sealing for the multi-round-trip requestState (SEP-2322): the
// convenience codec consumers drop into ServerOptions.requestState.verify.
export type { RequestStateCodec, RequestStateCodecOptions } from './server/requestStateCodec';
export { createRequestStateCodec } from './server/requestStateCodec';
export type { ServerOptions } from './server/server';
export { Server } from './server/server';
// subscriptions/listen change-event sourcing seam (protocol revision 2026-07-28).
export type { ServerEvent, ServerEventBus, ServerNotifier } from './server/serverEventBus';
export { InMemoryServerEventBus } from './server/serverEventBus';
// StdioServerTransport and the serveStdio entry are exported from the './stdio' subpath — server stdio
// has only type-level Node imports (erased at compile time), but matching the client's `./stdio` subpath
// gives consumers a consistent shape across packages.
export type {
    EventId,
    EventStore,
    HandleRequestOptions,
    StreamId,
    WebStandardStreamableHTTPServerTransportOptions
} from './server/streamableHttp';
export { WebStandardStreamableHTTPServerTransport } from './server/streamableHttp';

// runtime-aware wrapper (shadows core/public's fromJsonSchema with optional validator)
export { fromJsonSchema } from './fromJsonSchema';

// Inbound HTTP request classification (dual-era serving): the body-primary era
// predicate used by createMcpHandler, exported for hand-wired compositions.
export type {
    InboundClassificationOutcome,
    InboundHttpRequest,
    InboundLadderRejection,
    InboundLegacyRoute,
    InboundLegacyRouteReason,
    InboundModernRoute,
    InboundValidationRung
} from '@modelcontextprotocol/core-internal';
export { classifyInboundRequest } from '@modelcontextprotocol/core-internal';

// Cache hints for cacheable 2026-07-28 results (ServerOptions.cacheHints and
// the registerResource cacheHint option).
export type { CacheHint, CacheScope } from '@modelcontextprotocol/core-internal';

// Multi round-trip requests (protocol revision 2026-07-28): the authoring
// helpers a handler uses to request additional client input by returning an
// input-required result instead of sending a server→client request, and the
// typed readers for the responses a retried request carries back.
export type { ElicitInputParams, InputRequiredSpec, InputResponseView } from '@modelcontextprotocol/core-internal';
export { acceptedContent, inputRequired, inputResponse } from '@modelcontextprotocol/core-internal';

// re-export curated public API from core
export * from '@modelcontextprotocol/core-internal/public';
