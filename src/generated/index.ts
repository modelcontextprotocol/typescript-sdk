/**
 * Generated Zod Schemas and Types for MCP SDK
 *
 * This module provides:
 * - sdk.types.ts: Pre-processed types with SDK-compatible hierarchy
 * - sdk.schemas.ts: Zod schemas generated from sdk.types.ts
 *
 * Pre-processing transforms:
 * - `extends JSONRPCRequest` → `extends Request`
 * - `extends JSONRPCNotification` → `extends Notification`
 *
 * This allows SDK types/schemas to omit jsonrpc/id fields, which are
 * handled at the transport layer.
 *
 * @see sdk.types.ts - Pre-processed types (SDK hierarchy)
 * @see sdk.schemas.ts - Generated Zod schemas
 * @see ../types.ts - Re-exports from here + SDK extras
 */

// =============================================================================
// Generated Zod Schemas
// =============================================================================

export {
    // Primitives
    ProgressTokenSchema,
    CursorSchema,
    RequestIdSchema,

    // Base message types
    RequestParamsSchema,
    RequestSchema,
    NotificationParamsSchema,
    NotificationSchema,
    ResultSchema,
    ErrorSchema,

    // JSON-RPC types
    JSONRPCRequestSchema,
    JSONRPCNotificationSchema,
    JSONRPCResultResponseSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCResponseSchema,
    JSONRPCMessageSchema,

    // Empty/basic results
    EmptyResultSchema,

    // Cancelled notification
    CancelledNotificationParamsSchema,
    CancelledNotificationSchema,

    // Initialization
    ClientCapabilitiesSchema,
    ServerCapabilitiesSchema,
    InitializeRequestParamsSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    InitializedNotificationSchema,

    // Metadata and implementation
    IconSchema,
    IconsSchema,
    BaseMetadataSchema,
    ImplementationSchema,

    // Ping
    PingRequestSchema,

    // Progress
    ProgressNotificationParamsSchema,
    ProgressNotificationSchema,

    // Pagination
    PaginatedRequestParamsSchema,
    PaginatedRequestSchema,
    PaginatedResultSchema,

    // Resources
    ResourceSchema,
    ResourceTemplateSchema,
    ResourceContentsSchema,
    TextResourceContentsSchema,
    BlobResourceContentsSchema,
    ResourceRequestParamsSchema,
    ReadResourceRequestParamsSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ResourceListChangedNotificationSchema,
    SubscribeRequestParamsSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestParamsSchema,
    UnsubscribeRequestSchema,
    ResourceUpdatedNotificationParamsSchema,
    ResourceUpdatedNotificationSchema,

    // Prompts
    PromptSchema,
    PromptArgumentSchema,
    PromptMessageSchema,
    PromptReferenceSchema,
    RoleSchema,
    AnnotationsSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    GetPromptRequestParamsSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    PromptListChangedNotificationSchema,

    // Content types
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolUseContentSchema,
    ToolResultContentSchema,
    EmbeddedResourceSchema,
    ResourceLinkSchema,
    ContentBlockSchema,

    // Tools
    ToolSchema,
    ToolAnnotationsSchema,
    ToolExecutionSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    CallToolRequestParamsSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    ToolListChangedNotificationSchema,
    TaskAugmentedRequestParamsSchema,

    // Tasks
    TaskSchema,
    TaskStatusSchema,
    TaskMetadataSchema,
    RelatedTaskMetadataSchema,
    CreateTaskResultSchema,
    GetTaskRequestSchema,
    GetTaskResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    CancelTaskRequestSchema,
    CancelTaskResultSchema,
    ListTasksRequestSchema,
    ListTasksResultSchema,
    TaskStatusNotificationParamsSchema,
    TaskStatusNotificationSchema,

    // Logging
    LoggingLevelSchema,
    SetLevelRequestParamsSchema,
    SetLevelRequestSchema,
    LoggingMessageNotificationParamsSchema,
    LoggingMessageNotificationSchema,

    // Sampling/Messages
    ToolChoiceSchema,
    ModelHintSchema,
    ModelPreferencesSchema,
    SamplingMessageContentBlockSchema,
    SamplingMessageSchema,
    CreateMessageRequestParamsSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,

    // Completion
    ResourceTemplateReferenceSchema,
    CompleteRequestParamsSchema,
    CompleteRequestSchema,
    CompleteResultSchema,

    // Roots
    RootSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    RootsListChangedNotificationSchema,

    // Elicitation
    StringSchemaSchema,
    NumberSchemaSchema,
    BooleanSchemaSchema,
    EnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    SingleSelectEnumSchemaSchema,
    UntitledMultiSelectEnumSchemaSchema,
    TitledMultiSelectEnumSchemaSchema,
    MultiSelectEnumSchemaSchema,
    LegacyTitledEnumSchemaSchema,
    PrimitiveSchemaDefinitionSchema,
    ElicitRequestParamsSchema,
    ElicitRequestFormParamsSchema,
    ElicitRequestURLParamsSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    ElicitationCompleteNotificationSchema,
    URLElicitationRequiredErrorSchema,

    // Aggregate message types
    ClientRequestSchema,
    ClientNotificationSchema,
    ClientResultSchema,
    ServerRequestSchema,
    ServerNotificationSchema,
    ServerResultSchema
} from './sdk.schemas.js';

// =============================================================================
// SDK-Compatible Types (pre-processed from spec.types.ts)
// =============================================================================

export type {
    // Primitives
    ProgressToken,
    Cursor,
    RequestId,

    // Base message types
    RequestParams,
    Request,
    NotificationParams,
    Notification,
    Result,
    Error,

    // JSON-RPC types
    JSONRPCRequest,
    JSONRPCNotification,
    JSONRPCResultResponse,
    JSONRPCErrorResponse,
    JSONRPCResponse,
    JSONRPCMessage,

    // Empty/basic results
    EmptyResult,

    // Cancelled notification
    CancelledNotificationParams,
    CancelledNotification,

    // Initialization
    ClientCapabilities,
    ServerCapabilities,
    InitializeRequestParams,
    InitializeRequest,
    InitializeResult,
    InitializedNotification,

    // Metadata and implementation
    Icon,
    Icons,
    BaseMetadata,
    Implementation,

    // Ping
    PingRequest,

    // Progress
    ProgressNotificationParams,
    ProgressNotification,

    // Pagination
    PaginatedRequestParams,
    PaginatedRequest,
    PaginatedResult,

    // Resources
    Resource,
    ResourceTemplate,
    ResourceContents,
    TextResourceContents,
    BlobResourceContents,
    ResourceRequestParams,
    ReadResourceRequestParams,
    ReadResourceRequest,
    ReadResourceResult,
    ListResourcesRequest,
    ListResourcesResult,
    ListResourceTemplatesRequest,
    ListResourceTemplatesResult,
    ResourceListChangedNotification,
    SubscribeRequestParams,
    SubscribeRequest,
    UnsubscribeRequestParams,
    UnsubscribeRequest,
    ResourceUpdatedNotificationParams,
    ResourceUpdatedNotification,

    // Prompts
    Prompt,
    PromptArgument,
    PromptMessage,
    PromptReference,
    Role,
    Annotations,
    ListPromptsRequest,
    ListPromptsResult,
    GetPromptRequestParams,
    GetPromptRequest,
    GetPromptResult,
    PromptListChangedNotification,

    // Content types
    TextContent,
    ImageContent,
    AudioContent,
    ToolUseContent,
    ToolResultContent,
    EmbeddedResource,
    ResourceLink,
    ContentBlock,

    // Tools
    Tool,
    ToolAnnotations,
    ToolExecution,
    ListToolsRequest,
    ListToolsResult,
    CallToolRequestParams,
    CallToolRequest,
    CallToolResult,
    ToolListChangedNotification,
    TaskAugmentedRequestParams,

    // Tasks
    Task,
    TaskStatus,
    TaskMetadata,
    RelatedTaskMetadata,
    CreateTaskResult,
    GetTaskRequest,
    GetTaskResult,
    GetTaskPayloadRequest,
    GetTaskPayloadResult,
    CancelTaskRequest,
    CancelTaskResult,
    ListTasksRequest,
    ListTasksResult,
    TaskStatusNotificationParams,
    TaskStatusNotification,

    // Logging
    LoggingLevel,
    SetLevelRequestParams,
    SetLevelRequest,
    LoggingMessageNotificationParams,
    LoggingMessageNotification,

    // Sampling/Messages
    ToolChoice,
    ModelHint,
    ModelPreferences,
    SamplingMessageContentBlock,
    SamplingMessage,
    CreateMessageRequestParams,
    CreateMessageRequest,
    CreateMessageResult,

    // Completion
    ResourceTemplateReference,
    CompleteRequestParams,
    CompleteRequest,
    CompleteResult,

    // Roots
    Root,
    ListRootsRequest,
    ListRootsResult,
    RootsListChangedNotification,

    // Elicitation
    StringSchema,
    NumberSchema,
    BooleanSchema,
    EnumSchema,
    UntitledSingleSelectEnumSchema,
    TitledSingleSelectEnumSchema,
    SingleSelectEnumSchema,
    UntitledMultiSelectEnumSchema,
    TitledMultiSelectEnumSchema,
    MultiSelectEnumSchema,
    LegacyTitledEnumSchema,
    PrimitiveSchemaDefinition,
    ElicitRequestParams,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitRequest,
    ElicitResult,
    ElicitationCompleteNotification,
    URLElicitationRequiredError,

    // Aggregate message types
    ClientRequest,
    ClientNotification,
    ClientResult,
    ServerRequest,
    ServerNotification,
    ServerResult
} from './sdk.types.js';

// =============================================================================
// SDK Constants (from types.ts, not spec)
// =============================================================================

export { LATEST_PROTOCOL_VERSION, DEFAULT_NEGOTIATED_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, JSONRPC_VERSION } from '../types.js';
