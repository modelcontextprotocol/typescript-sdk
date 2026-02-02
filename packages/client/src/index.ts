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
// ============================================================================

// --- auth/errors.ts ---
export {
    AccessDeniedError,
    CustomOAuthError,
    InsufficientScopeError,
    InvalidClientError,
    InvalidClientMetadataError,
    InvalidGrantError,
    InvalidRequestError,
    InvalidScopeError,
    InvalidTargetError,
    InvalidTokenError,
    MethodNotAllowedError,
    OAuthError,
    ServerError,
    TemporarilyUnavailableError,
    TooManyRequestsError,
    UnauthorizedClientError,
    UnsupportedGrantTypeError,
    UnsupportedResponseTypeError,
    UnsupportedTokenTypeError
} from '@modelcontextprotocol/core';

// --- shared/auth.ts ---
export type {
    AuthorizationServerMetadata,
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientRegistrationError,
    OAuthErrorResponse,
    OAuthMetadata,
    OAuthProtectedResourceMetadata,
    OAuthTokenRevocationRequest,
    OAuthTokens,
    OpenIdProviderDiscoveryMetadata,
    OpenIdProviderMetadata
} from '@modelcontextprotocol/core';
export {
    OAuthClientInformationFullSchema,
    OAuthClientInformationSchema,
    OAuthClientMetadataSchema,
    OAuthClientRegistrationErrorSchema,
    OAuthErrorResponseSchema,
    OAuthMetadataSchema,
    OAuthProtectedResourceMetadataSchema,
    OAuthTokenRevocationRequestSchema,
    OAuthTokensSchema,
    OpenIdProviderDiscoveryMetadataSchema,
    OpenIdProviderMetadataSchema
} from '@modelcontextprotocol/core';

// --- shared/authUtils.ts ---
export { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/core';

// --- shared/metadataUtils.ts ---
export { getDisplayName } from '@modelcontextprotocol/core';

// --- shared/protocol.ts (excluding Protocol class, mergeCapabilities) ---
export type {
    NotificationOptions,
    ProgressCallback,
    ProtocolOptions,
    RequestHandlerExtra,
    RequestOptions,
    RequestTaskStore,
    TaskRequestOptions
} from '@modelcontextprotocol/core';
export { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/core';

// --- shared/responseMessage.ts (excluding AsyncGeneratorValue) ---
export type {
    BaseResponseMessage,
    ErrorMessage,
    ResponseMessage,
    ResultMessage,
    TaskCreatedMessage,
    TaskStatusMessage
} from '@modelcontextprotocol/core';
export { takeResult, toArrayAsync } from '@modelcontextprotocol/core';

// --- shared/transport.ts (excluding normalizeHeaders) ---
export type { FetchLike, Transport, TransportSendOptions } from '@modelcontextprotocol/core';
export { createFetchWithInit } from '@modelcontextprotocol/core';

// --- shared/uriTemplate.ts ---
export type { Variables } from '@modelcontextprotocol/core';
export { UriTemplate } from '@modelcontextprotocol/core';

// --- types/types.ts ---
export type {
    Annotations,
    AudioContent,
    AuthInfo,
    BaseMetadata,
    BlobResourceContents,
    BooleanSchema,
    CallToolRequest,
    CallToolRequestParams,
    CallToolResult,
    CancelledNotification,
    CancelledNotificationParams,
    CancelTaskRequest,
    CancelTaskResult,
    ClientCapabilities,
    ClientNotification,
    ClientRequest,
    ClientResult,
    CompatibilityCallToolResult,
    CompleteRequest,
    CompleteRequestParams,
    CompleteRequestPrompt,
    CompleteRequestResourceTemplate,
    CompleteResult,
    ContentBlock,
    CreateMessageRequest,
    CreateMessageRequestParams,
    CreateMessageRequestParamsBase,
    CreateMessageRequestParamsWithTools,
    CreateMessageResult,
    CreateMessageResultWithTools,
    CreateTaskResult,
    Cursor,
    ElicitationCompleteNotification,
    ElicitationCompleteNotificationParams,
    ElicitRequest,
    ElicitRequestFormParams,
    ElicitRequestParams,
    ElicitRequestURLParams,
    ElicitResult,
    EmbeddedResource,
    EmptyResult,
    EnumSchema,
    GetPromptRequest,
    GetPromptRequestParams,
    GetPromptResult,
    GetTaskPayloadRequest,
    GetTaskPayloadResult,
    GetTaskRequest,
    GetTaskResult,
    Icon,
    Icons,
    ImageContent,
    Implementation,
    InitializedNotification,
    InitializeRequest,
    InitializeRequestParams,
    InitializeResult,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    LegacyTitledEnumSchema,
    ListChangedCallback,
    ListChangedHandlers,
    ListChangedOptions,
    ListPromptsRequest,
    ListPromptsResult,
    ListResourcesRequest,
    ListResourcesResult,
    ListResourceTemplatesRequest,
    ListResourceTemplatesResult,
    ListRootsRequest,
    ListRootsResult,
    ListTasksRequest,
    ListTasksResult,
    ListToolsRequest,
    ListToolsResult,
    LoggingLevel,
    LoggingMessageNotification,
    LoggingMessageNotificationParams,
    MessageExtraInfo,
    ModelHint,
    ModelPreferences,
    MultiSelectEnumSchema,
    Notification,
    NotificationParams,
    NumberSchema,
    PaginatedRequest,
    PaginatedRequestParams,
    PaginatedResult,
    PingRequest,
    PrimitiveSchemaDefinition,
    Progress,
    ProgressNotification,
    ProgressNotificationParams,
    ProgressToken,
    Prompt,
    PromptArgument,
    PromptListChangedNotification,
    PromptMessage,
    PromptReference,
    ReadResourceRequest,
    ReadResourceRequestParams,
    ReadResourceResult,
    RelatedTaskMetadata,
    Request,
    RequestId,
    RequestInfo,
    RequestMeta,
    RequestParams,
    Resource,
    ResourceContents,
    ResourceLink,
    ResourceListChangedNotification,
    ResourceRequestParams,
    ResourceTemplateReference,
    ResourceTemplateType,
    ResourceUpdatedNotification,
    ResourceUpdatedNotificationParams,
    Result,
    Role,
    Root,
    RootsListChangedNotification,
    SamplingContent,
    SamplingMessage,
    SamplingMessageContentBlock,
    ServerCapabilities,
    ServerNotification,
    ServerRequest,
    ServerResult,
    SetLevelRequest,
    SetLevelRequestParams,
    SingleSelectEnumSchema,
    StringSchema,
    SubscribeRequest,
    SubscribeRequestParams,
    Task,
    TaskAugmentedRequestParams,
    TaskCreationParams,
    TaskMetadata,
    TaskStatus,
    TaskStatusNotification,
    TaskStatusNotificationParams,
    TextContent,
    TextResourceContents,
    TitledMultiSelectEnumSchema,
    TitledSingleSelectEnumSchema,
    Tool,
    ToolAnnotations,
    ToolChoice,
    ToolExecution,
    ToolListChangedNotification,
    ToolResultContent,
    ToolUseContent,
    UnsubscribeRequest,
    UnsubscribeRequestParams,
    UntitledMultiSelectEnumSchema,
    UntitledSingleSelectEnumSchema
} from '@modelcontextprotocol/core';
export {
    AnnotationsSchema,
    assertCompleteRequestPrompt,
    assertCompleteRequestResourceTemplate,
    AudioContentSchema,
    BaseMetadataSchema,
    BlobResourceContentsSchema,
    BooleanSchemaSchema,
    CallToolRequestParamsSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelledNotificationParamsSchema,
    CancelledNotificationSchema,
    CancelTaskRequestSchema,
    CancelTaskResultSchema,
    ClientCapabilitiesSchema,
    ClientNotificationSchema,
    ClientRequestSchema,
    ClientResultSchema,
    ClientTasksCapabilitySchema,
    CompatibilityCallToolResultSchema,
    CompleteRequestParamsSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    ContentBlockSchema,
    CreateMessageRequestParamsSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    CreateTaskResultSchema,
    CursorSchema,
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    ElicitationCompleteNotificationParamsSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestFormParamsSchema,
    ElicitRequestParamsSchema,
    ElicitRequestSchema,
    ElicitRequestURLParamsSchema,
    ElicitResultSchema,
    EmbeddedResourceSchema,
    EmptyResultSchema,
    EnumSchemaSchema,
    ErrorCode,
    GetPromptRequestParamsSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    GetTaskRequestSchema,
    GetTaskResultSchema,
    IconSchema,
    IconsSchema,
    ImageContentSchema,
    ImplementationSchema,
    InitializedNotificationSchema,
    InitializeRequestParamsSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    isInitializedNotification,
    isInitializeRequest,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    isTaskAugmentedRequestParams,
    JSONRPC_VERSION,
    JSONRPCErrorResponseSchema,
    JSONRPCMessageSchema,
    JSONRPCNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCResponseSchema,
    JSONRPCResultResponseSchema,
    LATEST_PROTOCOL_VERSION,
    LegacyTitledEnumSchemaSchema,
    ListChangedOptionsBaseSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    ListTasksRequestSchema,
    ListTasksResultSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    LoggingLevelSchema,
    LoggingMessageNotificationParamsSchema,
    LoggingMessageNotificationSchema,
    McpError,
    ModelHintSchema,
    ModelPreferencesSchema,
    MultiSelectEnumSchemaSchema,
    NotificationSchema,
    NumberSchemaSchema,
    PaginatedRequestParamsSchema,
    PaginatedRequestSchema,
    PaginatedResultSchema,
    PingRequestSchema,
    PrimitiveSchemaDefinitionSchema,
    ProgressNotificationParamsSchema,
    ProgressNotificationSchema,
    ProgressSchema,
    ProgressTokenSchema,
    PromptArgumentSchema,
    PromptListChangedNotificationSchema,
    PromptMessageSchema,
    PromptReferenceSchema,
    PromptSchema,
    ReadResourceRequestParamsSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    RELATED_TASK_META_KEY,
    RelatedTaskMetadataSchema,
    RequestIdSchema,
    RequestSchema,
    ResourceContentsSchema,
    ResourceLinkSchema,
    ResourceListChangedNotificationSchema,
    ResourceRequestParamsSchema,
    ResourceSchema,
    ResourceTemplateReferenceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationParamsSchema,
    ResourceUpdatedNotificationSchema,
    ResultSchema,
    RoleSchema,
    RootSchema,
    RootsListChangedNotificationSchema,
    SamplingContentSchema,
    SamplingMessageContentBlockSchema,
    SamplingMessageSchema,
    ServerCapabilitiesSchema,
    ServerNotificationSchema,
    ServerRequestSchema,
    ServerResultSchema,
    ServerTasksCapabilitySchema,
    SetLevelRequestParamsSchema,
    SetLevelRequestSchema,
    SingleSelectEnumSchemaSchema,
    StringSchemaSchema,
    SubscribeRequestParamsSchema,
    SubscribeRequestSchema,
    SUPPORTED_PROTOCOL_VERSIONS,
    TaskAugmentedRequestParamsSchema,
    TaskCreationParamsSchema,
    TaskMetadataSchema,
    TaskSchema,
    TaskStatusNotificationParamsSchema,
    TaskStatusNotificationSchema,
    TaskStatusSchema,
    TextContentSchema,
    TextResourceContentsSchema,
    TitledMultiSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    ToolAnnotationsSchema,
    ToolChoiceSchema,
    ToolExecutionSchema,
    ToolListChangedNotificationSchema,
    ToolResultContentSchema,
    ToolSchema,
    ToolUseContentSchema,
    UnsubscribeRequestParamsSchema,
    UnsubscribeRequestSchema,
    UntitledMultiSelectEnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    UrlElicitationRequiredError
} from '@modelcontextprotocol/core';

// --- util/inMemory.ts ---
export { InMemoryTransport } from '@modelcontextprotocol/core';

// --- experimental/tasks (from core) ---
export type {
    BaseQueuedMessage,
    CreateTaskOptions,
    CreateTaskRequestHandlerExtra,
    QueuedError,
    QueuedMessage,
    QueuedNotification,
    QueuedRequest,
    QueuedResponse,
    TaskMessageQueue,
    TaskRequestHandlerExtra,
    TaskStore,
    TaskToolExecution
} from '@modelcontextprotocol/core';
export {
    assertClientRequestTaskCapability,
    assertToolsCallTaskCapability,
    InMemoryTaskMessageQueue,
    InMemoryTaskStore,
    isTerminal
} from '@modelcontextprotocol/core';

// --- validation/types.ts ---
export type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from '@modelcontextprotocol/core';

// --- validation providers ---
export type { CfWorkerSchemaDraft } from '@modelcontextprotocol/core';
export { AjvJsonSchemaValidator } from '@modelcontextprotocol/core';
export { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/core';
