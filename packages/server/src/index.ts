/**
 * Public API surface for @modelcontextprotocol/server
 *
 * This barrel deliberately enumerates every exported symbol.
 * Nothing is exported via `export *` to prevent accidental surface growth.
 * See docs/v2-public-api-plan.md for the rationale behind each decision.
 */

// ==================================================================
// Core: errors & constants
// ==================================================================
export { McpError, UrlElicitationRequiredError, ErrorCode } from '@modelcontextprotocol/core';
export { LATEST_PROTOCOL_VERSION, DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/core';

// ==================================================================
// Core: transport contract
// ==================================================================
export type { Transport, TransportSendOptions } from '@modelcontextprotocol/core';

// ==================================================================
// Core: protocol flow types (used by every handler / request call)
// ==================================================================
export type {
    ProtocolOptions,
    RequestOptions,
    NotificationOptions,
    ProgressCallback,
    RequestHandlerExtra,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: auth & request context (available in handler extra)
// ==================================================================
export type { AuthInfo, RequestInfo } from '@modelcontextprotocol/core';

// ==================================================================
// Core: implementation & capability types
// ==================================================================
export type {
    Implementation,
    ClientCapabilities,
    ServerCapabilities,
    Role,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: content & message types users construct or pattern-match
// ==================================================================
export type {
    Tool,
    ToolAnnotations,
    ToolExecution,
    Resource,
    Prompt,
    PromptArgument,
    PromptMessage,
    TextContent,
    ImageContent,
    AudioContent,
    ContentBlock,
    ToolUseContent,
    ToolResultContent,
    EmbeddedResource,
    ResourceLink,
    TextResourceContents,
    BlobResourceContents,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: logging types
// ==================================================================
export type { LoggingLevel, LoggingMessageNotification } from '@modelcontextprotocol/core';

// ==================================================================
// Core: sampling types (for createMessage server → client requests)
// ==================================================================
export type {
    SamplingMessage,
    SamplingContent,
    SamplingMessageContentBlock,
    ModelHint,
    ModelPreferences,
    ToolChoice,
    CreateMessageRequestParams,
    CreateMessageRequestParamsBase,
    CreateMessageRequestParamsWithTools,
    CreateMessageResult,
    CreateMessageResultWithTools,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: elicitation types
// ==================================================================
export type {
    ElicitRequestParams,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: per-method request schemas (for low-level setRequestHandler)
// ==================================================================
export {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ReadResourceRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    SetLevelRequestSchema,
    CompleteRequestSchema,
    PingRequestSchema,
    InitializeRequestSchema,
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ListRootsRequestSchema,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: per-method result schemas & types
// ==================================================================
export {
    CallToolResultSchema,
    ListToolsResultSchema,
    GetPromptResultSchema,
    ListPromptsResultSchema,
    ReadResourceResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    CompleteResultSchema,
    CreateMessageResultSchema,
    ElicitResultSchema,
    ListRootsResultSchema,
} from '@modelcontextprotocol/core';

export type {
    CallToolResult,
    ListToolsResult,
    GetPromptResult,
    ListPromptsResult,
    ReadResourceResult,
    ListResourcesResult,
    ListResourceTemplatesResult,
    CompleteResult,
    ListRootsResult,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: completion helpers & types
// ==================================================================
export { assertCompleteRequestPrompt, assertCompleteRequestResourceTemplate } from '@modelcontextprotocol/core';

export type {
    CompleteRequest,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    PromptReference,
    ResourceTemplateReference,
} from '@modelcontextprotocol/core';

// ==================================================================
// Core: roots types
// ==================================================================
export type { Root, RootsListChangedNotification } from '@modelcontextprotocol/core';

// ==================================================================
// Core: URI template
// ==================================================================
export { UriTemplate } from '@modelcontextprotocol/core';

// ==================================================================
// Core: validation
// ==================================================================
export { AjvJsonSchemaValidator, CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/core';
export type { JsonSchemaValidator, JsonSchemaValidatorResult } from '@modelcontextprotocol/core';

// ==================================================================
// Server: high-level API
// ==================================================================
export { McpServer, ResourceTemplate as McpResourceTemplate } from './server/mcp.js';

export type {
    RegisteredTool,
    RegisteredResource,
    RegisteredResourceTemplate,
    RegisteredPrompt,
    ToolCallback,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceTemplateCallback,
    ListResourcesCallback,
    ResourceMetadata,
    CompleteResourceTemplateCallback,
} from './server/mcp.js';

// ==================================================================
// Server: low-level API
// ==================================================================
export { Server } from './server/server.js';
export type { ServerOptions } from './server/server.js';

// ==================================================================
// Server: completable() helper for auto-completion
// ==================================================================
export { completable } from './server/completable.js';
export type { CompleteCallback, CompletableSchema } from './server/completable.js';

// ==================================================================
// Server: transports
// ==================================================================
export { StdioServerTransport } from './server/stdio.js';

export { WebStandardStreamableHTTPServerTransport } from './server/streamableHttp.js';
export type {
    EventStore,
    WebStandardStreamableHTTPServerTransportOptions,
    HandleRequestOptions,
} from './server/streamableHttp.js';

// ==================================================================
// Server: host-header validation middleware helpers
// ==================================================================
export { localhostAllowedHostnames, hostHeaderValidationResponse } from './server/middleware/hostHeaderValidation.js';
