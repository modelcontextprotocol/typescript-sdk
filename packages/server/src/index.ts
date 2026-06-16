// Public API for @modelcontextprotocol/server.
//
// This file defines the complete public surface. It consists of:
//   - Package-specific exports: listed explicitly below (named imports)
//   - Protocol-level types: re-exported from @modelcontextprotocol/core/public
//
// Any new export added here becomes public API. Use named exports, not wildcards.

export type { CompletableSchema, CompleteCallback } from './server/completable.js';
export { completable, isCompletable } from './server/completable.js';
export type {
    CreateMcpHandlerOptions,
    LegacyHttpHandler,
    McpHandlerRequestOptions,
    McpHttpHandler,
    McpRequestContext,
    McpServerFactory,
    NodeIncomingMessageLike,
    NodeServerResponseLike
} from './server/createMcpHandler.js';
export { createMcpHandler, legacyStatelessFallback } from './server/createMcpHandler.js';
export type {
    AnyToolHandler,
    BaseToolCallback,
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
} from './server/mcp.js';
export { McpServer, ResourceTemplate } from './server/mcp.js';
export type { HostHeaderValidationResult } from './server/middleware/hostHeaderValidation.js';
export { hostHeaderValidationResponse, localhostAllowedHostnames, validateHostHeader } from './server/middleware/hostHeaderValidation.js';
export type { OriginValidationResult } from './server/middleware/originValidation.js';
export { localhostAllowedOrigins, originValidationResponse, validateOriginHeader } from './server/middleware/originValidation.js';
export type { PerRequestHTTPServerTransportOptions, PerRequestMessageExtra, PerRequestResponseMode } from './server/perRequestTransport.js';
export { PerRequestHTTPServerTransport } from './server/perRequestTransport.js';
export type { ServerOptions } from './server/server.js';
export { Server } from './server/server.js';
// StdioServerTransport is exported from the './stdio' subpath — server stdio has only type-level Node
// imports (erased at compile time), but matching the client's `./stdio` subpath gives consumers a
// consistent shape across packages.
export type {
    EventId,
    EventStore,
    HandleRequestOptions,
    StreamId,
    WebStandardStreamableHTTPServerTransportOptions
} from './server/streamableHttp.js';
export { WebStandardStreamableHTTPServerTransport } from './server/streamableHttp.js';

// runtime-aware wrapper (shadows core/public's fromJsonSchema with optional validator)
export { fromJsonSchema } from './fromJsonSchema.js';

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
} from '@modelcontextprotocol/core';
export { classifyInboundRequest } from '@modelcontextprotocol/core';

// re-export curated public API from core
export * from '@modelcontextprotocol/core/public';
