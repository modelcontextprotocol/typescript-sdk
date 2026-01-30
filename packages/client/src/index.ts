/**
 * Public API surface for @modelcontextprotocol/client
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
// Core: OAuth types (needed by OAuthClientProvider implementors)
// ==================================================================
export type {
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthTokens,
    OAuthMetadata,
    OAuthProtectedResourceMetadata,
    AuthorizationServerMetadata,
} from '@modelcontextprotocol/core';

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
// Client: main class
// ==================================================================
export { Client } from './client/client.js';
export type { ClientOptions } from './client/client.js';

// ==================================================================
// Client: auth
// ==================================================================
export { UnauthorizedError } from './client/auth.js';
export type { OAuthClientProvider } from './client/auth.js';

// ==================================================================
// Client: auth extensions (OAuth provider implementations)
// ==================================================================
export {
    ClientCredentialsProvider,
    PrivateKeyJwtProvider,
    StaticPrivateKeyJwtProvider,
    createPrivateKeyJwtAuth,
} from './client/authExtensions.js';

export type {
    ClientCredentialsProviderOptions,
    PrivateKeyJwtProviderOptions,
    StaticPrivateKeyJwtProviderOptions,
} from './client/authExtensions.js';

// ==================================================================
// Client: fetch middleware
// ==================================================================
export { withOAuth, withLogging, applyMiddlewares, createMiddleware } from './client/middleware.js';
export type { Middleware, RequestLogger, LoggingOptions } from './client/middleware.js';

// ==================================================================
// Client: transports
// ==================================================================
export { SSEClientTransport } from './client/sse.js';
export type { SSEClientTransportOptions } from './client/sse.js';

export { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment } from './client/stdio.js';
export type { StdioServerParameters } from './client/stdio.js';

export { StreamableHTTPClientTransport, StreamableHTTPError } from './client/streamableHttp.js';
export type { StreamableHTTPClientTransportOptions, StreamableHTTPReconnectionOptions } from './client/streamableHttp.js';

export { WebSocketClientTransport } from './client/websocket.js';
