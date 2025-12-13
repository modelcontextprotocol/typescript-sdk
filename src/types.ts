import * as z from 'zod/v4';
import { AuthInfo } from './server/auth/types.js';

// =============================================================================
// Type imports from generated sdk.types.ts (for use within this file)
// =============================================================================
import type {
    JSONRPCRequest,
    JSONRPCNotification,
    JSONRPCResultResponse,
    JSONRPCErrorResponse,
    RequestParams,
    // Types used in schema definitions below
    TaskAugmentedRequestParams,
    InitializeRequest,
    InitializedNotification,
    Tool,
    Prompt,
    Resource,
    CompleteRequest,
    ElicitRequestURLParams,
    CreateMessageRequestParams,
    ResourceTemplateReference,
    PromptReference,
    CompleteRequestParams,
    ProgressNotificationParams,
} from './generated/sdk.types.js';

// =============================================================================
// Re-exports from generated schemas
// =============================================================================
// These schemas are generated from spec.types.ts and are identical to the
// manually-defined versions. Re-exporting reduces duplication and ensures
// consistency with the MCP specification.

// Primitive type schemas - import for local use and re-export
import {
    ProgressTokenSchema,
    CursorSchema,
    RequestIdSchema,
    RoleSchema,
    TaskStatusSchema,
    LoggingLevelSchema,
    // Base metadata schemas (IconSchema adds 'theme' field from latest spec)
    IconSchema,
    IconsSchema,
    BaseMetadataSchema,
    // ImplementationSchema adds 'description' field from latest spec
    ImplementationSchema,
    // Error schema for JSON-RPC errors
    ErrorSchema,
    // Task-related schemas
    TaskMetadataSchema,
    RelatedTaskMetadataSchema,
    // Sampling-related schemas
    ModelHintSchema,
    ModelPreferencesSchema,
    ToolChoiceSchema,
    // Tool-related schemas
    ToolAnnotationsSchema,
    ToolExecutionSchema,
    // Elicitation primitive schemas
    BooleanSchemaSchema,
    NumberSchemaSchema,
    // Schemas with enhanced validation (datetime, startsWith, base64)
    AnnotationsSchema,
    RootSchema,
    // Content schemas (with Base64 validation for data/blob fields)
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    EmbeddedResourceSchema,
    ResourceLinkSchema,
    ContentBlockSchema,
    // Resource content schemas
    ResourceContentsSchema,
    TextResourceContentsSchema,
    BlobResourceContentsSchema,
    // Request/notification base schemas (with RELATED_TASK_META_KEY injected)
    RequestParamsSchema,
    TaskAugmentedRequestParamsSchema,
    NotificationParamsSchema,
    // Core request/notification schemas (params include proper _meta typing)
    RequestSchema,
    NotificationSchema,
    ResultSchema,
    // Derived base schemas
    PaginatedResultSchema,
    PaginatedRequestSchema,
    // Simple request/notification schemas (no extra params beyond base)
    PingRequestSchema,
    InitializedNotificationSchema,
    CancelledNotificationSchema,
    ResourceListChangedNotificationSchema,
    PromptListChangedNotificationSchema,
    ToolListChangedNotificationSchema,
    RootsListChangedNotificationSchema,
    // JSON-RPC schemas (with .strict() for validation)
    JSONRPCRequestSchema,
    JSONRPCNotificationSchema,
    JSONRPCResultResponseSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCMessageSchema,
    // Resource request schemas
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    // Prompt request schemas
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    // Tool request schemas
    ListToolsRequestSchema,
    // Task request schemas
    GetTaskRequestSchema,
    GetTaskPayloadRequestSchema,
    ListTasksRequestSchema,
    CancelTaskRequestSchema,
    // Roots request schema
    ListRootsRequestSchema,
    // Initialize schemas
    InitializeRequestParamsSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    // Completion schemas
    CompleteRequestParamsSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    // Sampling schemas
    CreateMessageRequestParamsSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema as CreateMessageResultSpecSchema,
    // Elicitation schemas
    ElicitRequestFormParamsSchema,
    ElicitRequestURLParamsSchema,
    ElicitRequestParamsSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    ElicitationCompleteNotificationSchema,
    // More result schemas
    GetPromptResultSchema,
    GetTaskResultSchema,
    GetTaskPayloadResultSchema,
    CreateTaskResultSchema,
    CancelTaskResultSchema,
    ListTasksResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListPromptsResultSchema,
    ListToolsResultSchema,
    ListRootsResultSchema,
    // Call tool schemas
    CallToolRequestParamsSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    // Cancelled notification
    CancelledNotificationParamsSchema,
    // Logging
    SetLevelRequestSchema,
    LoggingMessageNotificationSchema,
    // Progress
    ProgressNotificationSchema,
    // Resource updated
    ResourceUpdatedNotificationSchema,
    // Task status
    TaskStatusNotificationSchema,
    // Sampling schemas
    SamplingMessageSchema,
    // Server/Client message type unions
    ServerRequestSchema,
    ServerNotificationSchema,
    ServerResultSchema,
    ClientRequestSchema,
    ClientNotificationSchema,
    ClientResultSchema,
    // Enum schemas
    SingleSelectEnumSchemaSchema,
    MultiSelectEnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    UntitledMultiSelectEnumSchemaSchema,
    TitledMultiSelectEnumSchemaSchema,
    LegacyTitledEnumSchemaSchema,
    EnumSchemaSchema,
    PrimitiveSchemaDefinitionSchema,
    // Reference schemas
    PromptReferenceSchema,
    ResourceTemplateReferenceSchema,
    // ReadResource schemas
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    // Prompt schemas
    PromptMessageSchema,
    PromptSchema,
    PromptArgumentSchema,
    // Resource schemas
    ResourceSchema,
    ResourceTemplateSchema,
    // Tool schemas
    ToolSchema,
    ToolUseContentSchema,
    ToolResultContentSchema,
    // String schema
    StringSchemaSchema,
    // Task schemas
    TaskSchema,
    TaskStatusNotificationParamsSchema,
    // Request/Notification params schemas
    PaginatedRequestParamsSchema,
    GetPromptRequestParamsSchema,
    LoggingMessageNotificationParamsSchema,
    // EmptyResult (with .strict())
    EmptyResultSchema,
    // Resource request params schemas
    ResourceRequestParamsSchema,
    ReadResourceRequestParamsSchema,
    SubscribeRequestParamsSchema,
    UnsubscribeRequestParamsSchema,
    ResourceUpdatedNotificationParamsSchema,
    SetLevelRequestParamsSchema,
    // Sampling schemas (now using discriminatedUnion)
    SamplingMessageContentBlockSchema,
    // Derived capability schemas (generated from extracted types)
    ClientTasksCapabilitySchema,
    ServerTasksCapabilitySchema,
    // Main capability schemas (with AssertObjectSchema and preprocess transforms)
    ClientCapabilitiesSchema,
    ServerCapabilitiesSchema,
    // Progress
    ProgressNotificationParamsSchema,
} from './generated/sdk.schemas.js';

export {
    ProgressTokenSchema,
    CursorSchema,
    RequestIdSchema,
    RoleSchema,
    TaskStatusSchema,
    LoggingLevelSchema,
    IconSchema,
    IconsSchema,
    BaseMetadataSchema,
    ImplementationSchema,
    ErrorSchema,
    TaskMetadataSchema,
    RelatedTaskMetadataSchema,
    ModelHintSchema,
    ModelPreferencesSchema,
    ToolChoiceSchema,
    ToolAnnotationsSchema,
    ToolExecutionSchema,
    BooleanSchemaSchema,
    NumberSchemaSchema,
    AnnotationsSchema,
    RootSchema,
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    EmbeddedResourceSchema,
    ResourceLinkSchema,
    ContentBlockSchema,
    ResourceContentsSchema,
    TextResourceContentsSchema,
    BlobResourceContentsSchema,
    // Core protocol schemas
    RequestSchema,
    NotificationSchema,
    ResultSchema,
    TaskAugmentedRequestParamsSchema,
    PaginatedResultSchema,
    PaginatedRequestSchema,
    PingRequestSchema,
    InitializedNotificationSchema,
    CancelledNotificationSchema,
    ResourceListChangedNotificationSchema,
    PromptListChangedNotificationSchema,
    ToolListChangedNotificationSchema,
    RootsListChangedNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCNotificationSchema,
    JSONRPCResultResponseSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCMessageSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ListToolsRequestSchema,
    GetTaskRequestSchema,
    GetTaskPayloadRequestSchema,
    ListTasksRequestSchema,
    CancelTaskRequestSchema,
    ListRootsRequestSchema,
    InitializeRequestParamsSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    CompleteRequestParamsSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    CreateMessageRequestParamsSchema,
    CreateMessageRequestSchema,
    // Note: CreateMessageResultSchema is defined locally for backwards compat (single content, no tools)
    // CreateMessageResultSpecSchema (generated) is used for CreateMessageResultWithToolsSchema
    ElicitRequestFormParamsSchema,
    ElicitRequestURLParamsSchema,
    ElicitRequestParamsSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    ElicitationCompleteNotificationSchema,
    GetPromptResultSchema,
    GetTaskResultSchema,
    GetTaskPayloadResultSchema,
    CreateTaskResultSchema,
    CancelTaskResultSchema,
    ListTasksResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ListPromptsResultSchema,
    ListToolsResultSchema,
    ListRootsResultSchema,
    CallToolRequestParamsSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelledNotificationParamsSchema,
    SetLevelRequestSchema,
    LoggingMessageNotificationSchema,
    ProgressNotificationSchema,
    ResourceUpdatedNotificationSchema,
    TaskStatusNotificationSchema,
    SamplingMessageSchema,
    ServerRequestSchema,
    ServerNotificationSchema,
    ServerResultSchema,
    ClientRequestSchema,
    ClientNotificationSchema,
    ClientResultSchema,
    SingleSelectEnumSchemaSchema,
    MultiSelectEnumSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    UntitledMultiSelectEnumSchemaSchema,
    TitledMultiSelectEnumSchemaSchema,
    LegacyTitledEnumSchemaSchema,
    EnumSchemaSchema,
    PrimitiveSchemaDefinitionSchema,
    PromptReferenceSchema,
    ResourceTemplateReferenceSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    PromptMessageSchema,
    PromptSchema,
    PromptArgumentSchema,
    ResourceSchema,
    ResourceTemplateSchema,
    ToolSchema,
    ToolUseContentSchema,
    ToolResultContentSchema,
    StringSchemaSchema,
    TaskSchema,
    TaskStatusNotificationParamsSchema,
    PaginatedRequestParamsSchema,
    GetPromptRequestParamsSchema,
    LoggingMessageNotificationParamsSchema,
    EmptyResultSchema,
    ResourceRequestParamsSchema,
    ReadResourceRequestParamsSchema,
    SubscribeRequestParamsSchema,
    UnsubscribeRequestParamsSchema,
    ResourceUpdatedNotificationParamsSchema,
    SetLevelRequestParamsSchema,
    SamplingMessageContentBlockSchema,
    ClientTasksCapabilitySchema,
    ServerTasksCapabilitySchema,
    ClientCapabilitiesSchema,
    ServerCapabilitiesSchema,
    ProgressNotificationParamsSchema,
};

export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/**
 * Utility types
 */
type ExpandRecursively<T> = T extends object ? (T extends infer O ? { [K in keyof O]: ExpandRecursively<O[K]> } : never) : T;
/**
 * Assert 'object' type schema.
 *
 * @internal
 */
const AssertObjectSchema = z.custom<object>((v): v is object => v !== null && (typeof v === 'object' || typeof v === 'function'));

/**
 * Task creation parameters, used to ask that the server create a task to represent a request.
 */
export const TaskCreationParamsSchema = z.looseObject({
    /**
     * Time in milliseconds to keep task results available after completion.
     * If null, the task has unlimited lifetime until manually cleaned up.
     */
    ttl: z.union([z.number(), z.null()]).optional(),

    /**
     * Time in milliseconds to wait between task status requests.
     */
    pollInterval: z.number().optional()
});

// during pre-processing.

/**
 * Checks if a value is a valid TaskAugmentedRequestParams.
 * @param value - The value to check.
 *
 * @returns True if the value is a valid TaskAugmentedRequestParams, false otherwise.
 */
export const isTaskAugmentedRequestParams = (value: unknown): value is TaskAugmentedRequestParams =>
    TaskAugmentedRequestParamsSchema.safeParse(value).success;


export const isJSONRPCRequest = (value: unknown): value is JSONRPCRequest => JSONRPCRequestSchema.safeParse(value).success;
export const isJSONRPCNotification = (value: unknown): value is JSONRPCNotification => JSONRPCNotificationSchema.safeParse(value).success;
export const isJSONRPCResultResponse = (value: unknown): value is JSONRPCResultResponse =>
    JSONRPCResultResponseSchema.safeParse(value).success;
export const isJSONRPCErrorResponse = (value: unknown): value is JSONRPCErrorResponse =>
    JSONRPCErrorResponseSchema.safeParse(value).success;

/**
 * Error codes defined by the JSON-RPC specification.
 */
export enum ErrorCode {
    // SDK error codes
    ConnectionClosed = -32000,
    RequestTimeout = -32001,

    // Standard JSON-RPC error codes
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,

    // MCP-specific error codes
    UrlElicitationRequired = -32042
}

export const JSONRPCResponseSchema = z.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);

/* Cancellation */
/**
 * This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
 *
 * Note: CancelledNotificationSchema is re-exported from generated.
 */

/* Initialization */

/**
 * Elicitation capability schema - extracted from ClientCapabilitiesSchema.
 * Has special preprocessing to handle empty objects as { form: {} } for backwards compatibility.
 */
export const ElicitationCapabilitySchema = ClientCapabilitiesSchema.shape.elicitation.unwrap();

export const isInitializeRequest = (value: unknown): value is InitializeRequest => InitializeRequestSchema.safeParse(value).success;




export const isInitializedNotification = (value: unknown): value is InitializedNotification =>
    InitializedNotificationSchema.safeParse(value).success;

/* Ping */

/* Progress notifications */
/**
 * Progress schema - derived from ProgressNotificationParams without progressToken.
 * Used for the ProgressCallback signature in RequestOptions.
 */
export const ProgressSchema = ProgressNotificationParamsSchema.omit({ progressToken: true });

/* Pagination */

/* Tasks */

/* Resources */



// ResourceRequestParamsSchema, ReadResourceRequestParamsSchema,
// SubscribeRequestParamsSchema, UnsubscribeRequestParamsSchema,
// ReadResourceRequestSchema, ReadResourceResultSchema, ResourceListChangedNotificationSchema,

/* Prompts */


// from generated with Base64 validation for data fields.


/* Tools */
// ListToolsResultSchema, CallToolResultSchema, CallToolRequestParamsSchema,

/**
 * CallToolResultSchema extended with backwards compatibility to protocol version 2024-10-07.
 */
export const CompatibilityCallToolResultSchema = CallToolResultSchema.or(
    ResultSchema.extend({
        toolResult: z.unknown()
    })
);

/**
 * Callback type for list changed notifications.
 */
export type ListChangedCallback<T> = (error: Error | null, items: T[] | null) => void;

/**
 * Base schema for list changed subscription options (without callback).
 * Used internally for Zod validation of autoRefresh and debounceMs.
 */
export const ListChangedOptionsBaseSchema = z.object({
    /**
     * If true, the list will be refreshed automatically when a list changed notification is received.
     * The callback will be called with the updated list.
     *
     * If false, the callback will be called with null items, allowing manual refresh.
     *
     * @default true
     */
    autoRefresh: z.boolean().default(true),
    /**
     * Debounce time in milliseconds for list changed notification processing.
     *
     * Multiple notifications received within this timeframe will only trigger one refresh.
     * Set to 0 to disable debouncing.
     *
     * @default 300
     */
    debounceMs: z.number().int().nonnegative().default(300)
});

/**
 * Options for subscribing to list changed notifications.
 *
 * @typeParam T - The type of items in the list (Tool, Prompt, or Resource)
 */
export type ListChangedOptions<T> = {
    /**
     * If true, the list will be refreshed automatically when a list changed notification is received.
     * @default true
     */
    autoRefresh?: boolean;
    /**
     * Debounce time in milliseconds. Set to 0 to disable.
     * @default 300
     */
    debounceMs?: number;
    /**
     * Callback invoked when the list changes.
     *
     * If autoRefresh is true, items contains the updated list.
     * If autoRefresh is false, items is null (caller should refresh manually).
     */
    onChanged: ListChangedCallback<T>;
};

/**
 * Configuration for list changed notification handlers.
 *
 * Use this to configure handlers for tools, prompts, and resources list changes
 * when creating a client.
 *
 * Note: Handlers are only activated if the server advertises the corresponding
 * `listChanged` capability (e.g., `tools.listChanged: true`). If the server
 * doesn't advertise this capability, the handler will not be set up.
 */
export type ListChangedHandlers = {
    /**
     * Handler for tool list changes.
     */
    tools?: ListChangedOptions<Tool>;
    /**
     * Handler for prompt list changes.
     */
    prompts?: ListChangedOptions<Prompt>;
    /**
     * Handler for resource list changes.
     */
    resources?: ListChangedOptions<Resource>;
};

/* Logging */

/* Sampling */

/**
 * Basic content types for sampling responses (without tool use).
 * Used for backwards-compatible CreateMessageResult when tools are not used.
 */
export const SamplingContentSchema = z.discriminatedUnion('type', [TextContentSchema, ImageContentSchema, AudioContentSchema]);

// SamplingMessageSchema, CreateMessageRequestParamsSchema, CreateMessageRequestSchema,

/**
 * The client's response to a sampling/create_message request (backwards-compatible version).
 * Uses single content block without tool types for v1.x API compatibility.
 * For tool use support, use CreateMessageResultWithToolsSchema instead.
 */
export const CreateMessageResultSchema = CreateMessageResultSpecSchema
    .omit({ content: true })
    .extend({
        /** Response content. Single block, basic types only (text/image/audio). */
        content: SamplingContentSchema
    });

/**
 * The client's response to a sampling/create_message request when tools were provided.
 * This version supports array content for tool use flows.
 */
export const CreateMessageResultWithToolsSchema = ResultSchema.extend({
    /**
     * The name of the model that generated the message.
     */
    model: z.string(),
    /**
     * The reason why sampling stopped, if known.
     *
     * Standard values:
     * - "endTurn": Natural end of the assistant's turn
     * - "stopSequence": A stop sequence was encountered
     * - "maxTokens": Maximum token limit was reached
     * - "toolUse": The model wants to use one or more tools
     *
     * This field is an open string to allow for provider-specific stop reasons.
     */
    stopReason: z.optional(z.enum(['endTurn', 'stopSequence', 'maxTokens', 'toolUse']).or(z.string())),
    role: RoleSchema,
    /**
     * Response content. May be a single block or array. May include ToolUseContent if stopReason is "toolUse".
     */
    content: z.union([SamplingMessageContentBlockSchema, z.array(SamplingMessageContentBlockSchema)])
});

/* Elicitation */
// UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema,
// LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, UntitledMultiSelectEnumSchemaSchema,
// TitledMultiSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema, EnumSchemaSchema,


/**
 * Parameters for a `notifications/elicitation/complete` notification.
 *
 * @category notifications/elicitation/complete
 */
export const ElicitationCompleteNotificationParamsSchema = NotificationParamsSchema.extend({
    /**
     * The ID of the elicitation that completed.
     */
    elicitationId: z.string()
});

/* Autocomplete */

/**
 * @deprecated Use ResourceTemplateReferenceSchema instead
 */
export const ResourceReferenceSchema = ResourceTemplateReferenceSchema;


export function assertCompleteRequestPrompt(request: CompleteRequest): asserts request is CompleteRequestPrompt {
    if (request.params.ref.type !== 'ref/prompt') {
        throw new TypeError(`Expected CompleteRequestPrompt, but got ${request.params.ref.type}`);
    }
    void (request as CompleteRequestPrompt);
}

export function assertCompleteRequestResourceTemplate(request: CompleteRequest): asserts request is CompleteRequestResourceTemplate {
    if (request.params.ref.type !== 'ref/resource') {
        throw new TypeError(`Expected CompleteRequestResourceTemplate, but got ${request.params.ref.type}`);
    }
    void (request as CompleteRequestResourceTemplate);
}

/* Roots */

/* Client/Server message types */

export class McpError extends Error {
    constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown
    ) {
        super(`MCP error ${code}: ${message}`);
        this.name = 'McpError';
    }

    /**
     * Factory method to create the appropriate error type based on the error code and data
     */
    static fromError(code: number, message: string, data?: unknown): McpError {
        // Check for specific error types
        if (code === ErrorCode.UrlElicitationRequired && data) {
            const errorData = data as { elicitations?: unknown[] };
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations as ElicitRequestURLParams[], message);
            }
        }

        // Default to generic McpError
        return new McpError(code, message, data);
    }
}

/**
 * Specialized error type when a tool requires a URL mode elicitation.
 * This makes it nicer for the client to handle since there is specific data to work with instead of just a code to check against.
 */
export class UrlElicitationRequiredError extends McpError {
    constructor(elicitations: ElicitRequestURLParams[], message: string = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ErrorCode.UrlElicitationRequired, message, {
            elicitations: elicitations
        });
    }

    get elicitations(): ElicitRequestURLParams[] {
        return (this.data as { elicitations: ElicitRequestURLParams[] })?.elicitations ?? [];
    }
}

type Primitive = string | number | boolean | bigint | null | undefined;
type Flatten<T> = T extends Primitive
    ? T
    : T extends Array<infer U>
      ? Array<Flatten<U>>
      : T extends Set<infer U>
        ? Set<Flatten<U>>
        : T extends Map<infer K, infer V>
          ? Map<Flatten<K>, Flatten<V>>
          : T extends object
            ? { [K in keyof T]: Flatten<T[K]> }
            : T;

type Infer<Schema extends z.ZodTypeAny> = Flatten<z.infer<Schema>>;

/**
 * Headers that are compatible with both Node.js and the browser.
 */
export type IsomorphicHeaders = Record<string, string | string[] | undefined>;

/**
 * Information about the incoming request.
 */
export interface RequestInfo {
    /**
     * The headers of the request.
     */
    headers: IsomorphicHeaders;
}

/**
 * Extra information about a message.
 */
export interface MessageExtraInfo {
    /**
     * The request information.
     */
    requestInfo?: RequestInfo;

    /**
     * The authentication information.
     */
    authInfo?: AuthInfo;

    /**
     * Callback to close the SSE stream for this request, triggering client reconnection.
     * Only available when using StreamableHTTPServerTransport with eventStore configured.
     */
    closeSSEStream?: () => void;

    /**
     * Callback to close the standalone GET SSE stream, triggering client reconnection.
     * Only available when using StreamableHTTPServerTransport with eventStore configured.
     */
    closeStandaloneSSEStream?: () => void;
}

// Import base types with aliases to avoid DOM collision, then re-export
import type {
    Request as _Request,
    Notification as _Notification,
    Result as _Result,
} from './generated/sdk.types.js';

// Re-export with original names
export type { _Request as Request, _Notification as Notification, _Result as Result };

/* Types re-exported from generated sdk.types.ts */
export type {
    // Union types for narrowing (Mcp prefix)
    McpRequest,
    McpNotification,
    McpResult,
    // Params types
    RequestParams,
    NotificationParams,
    TaskAugmentedRequestParams,
    // Primitives
    ProgressToken,
    Cursor,
    RequestId,
    // JSON-RPC wire types
    JSONRPCRequest,
    JSONRPCNotification,
    JSONRPCResultResponse,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    // Empty result
    EmptyResult,
    // Cancellation
    CancelledNotificationParams,
    CancelledNotification,
    // Base Metadata
    Icon,
    Icons,
    BaseMetadata,
    Annotations,
    Role,
    // Initialization
    Implementation,
    ClientCapabilities,
    InitializeRequestParams,
    InitializeRequest,
    ServerCapabilities,
    InitializeResult,
    InitializedNotification,
    // Ping
    PingRequest,
    // Progress notifications
    ProgressNotificationParams,
    ProgressNotification,
    // Tasks
    Task,
    TaskStatus,
    TaskMetadata,
    RelatedTaskMetadata,
    CreateTaskResult,
    TaskStatusNotificationParams,
    TaskStatusNotification,
    GetTaskRequest,
    GetTaskResult,
    GetTaskPayloadRequest,
    ListTasksRequest,
    ListTasksResult,
    CancelTaskRequest,
    CancelTaskResult,
    GetTaskPayloadResult,
    // Pagination
    PaginatedRequestParams,
    PaginatedRequest,
    PaginatedResult,
    // Resources
    ResourceContents,
    TextResourceContents,
    BlobResourceContents,
    Resource,
    ResourceTemplate,
    ListResourcesRequest,
    ListResourcesResult,
    ListResourceTemplatesRequest,
    ListResourceTemplatesResult,
    ResourceRequestParams,
    ReadResourceRequestParams,
    ReadResourceRequest,
    ReadResourceResult,
    ResourceListChangedNotification,
    SubscribeRequestParams,
    SubscribeRequest,
    UnsubscribeRequestParams,
    UnsubscribeRequest,
    ResourceUpdatedNotificationParams,
    ResourceUpdatedNotification,
    // Prompts
    PromptArgument,
    Prompt,
    ListPromptsRequest,
    ListPromptsResult,
    GetPromptRequestParams,
    GetPromptRequest,
    TextContent,
    ImageContent,
    AudioContent,
    ToolUseContent,
    ToolResultContent,
    EmbeddedResource,
    ResourceLink,
    ContentBlock,
    PromptMessage,
    GetPromptResult,
    PromptListChangedNotification,
    // Tools
    ToolAnnotations,
    ToolExecution,
    Tool,
    ListToolsRequest,
    ListToolsResult,
    CallToolRequestParams,
    CallToolResult,
    CallToolRequest,
    ToolListChangedNotification,
    // Logging
    LoggingLevel,
    SetLevelRequestParams,
    SetLevelRequest,
    LoggingMessageNotificationParams,
    LoggingMessageNotification,
    // Sampling
    ToolChoice,
    ModelHint,
    ModelPreferences,
    SamplingMessageContentBlock,
    SamplingMessage,
    CreateMessageRequestParams,
    CreateMessageRequest,
    CreateMessageResult,
    // Elicitation
    BooleanSchema,
    StringSchema,
    NumberSchema,
    EnumSchema,
    UntitledSingleSelectEnumSchema,
    TitledSingleSelectEnumSchema,
    LegacyTitledEnumSchema,
    UntitledMultiSelectEnumSchema,
    TitledMultiSelectEnumSchema,
    SingleSelectEnumSchema,
    MultiSelectEnumSchema,
    PrimitiveSchemaDefinition,
    ElicitRequestParams,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitRequest,
    ElicitationCompleteNotification,
    ElicitResult,
    // Autocomplete
    ResourceTemplateReference,
    PromptReference,
    CompleteRequestParams,
    CompleteRequest,
    CompleteResult,
    // Roots
    Root,
    ListRootsRequest,
    ListRootsResult,
    RootsListChangedNotification,
    // Client messages
    ClientRequest,
    ClientNotification,
    ClientResult,
    // Server messages
    ServerRequest,
    ServerNotification,
    ServerResult,
} from './generated/sdk.types.js';

/**
 * Request metadata - the _meta field type from RequestParams.
 */
export type RequestMeta = RequestParams['_meta'];

/* SDK-specific types (not from spec, need Infer) */

// JSONRPCResponse is defined locally (union of result/error)
export type JSONRPCResponse = Infer<typeof JSONRPCResponseSchema>;

// Progress type - derived from ProgressNotificationParams without progressToken
export type Progress = Omit<ProgressNotificationParams, 'progressToken'>;
// Type check: ensure Progress matches the inferred schema type
type _ProgressCheck = Progress extends Infer<typeof ProgressSchema> ? Infer<typeof ProgressSchema> extends Progress ? true : never : never;
const _progressTypeCheck: _ProgressCheck = true;

// Task creation params (SDK-specific)
export type TaskCreationParams = Infer<typeof TaskCreationParamsSchema>;

// Compatibility helper for older tool results
export type CompatibilityCallToolResult = Infer<typeof CompatibilityCallToolResultSchema>;

// Sampling content (SDK-specific discriminated union)
export type SamplingContent = Infer<typeof SamplingContentSchema>;

// CreateMessageResult with tools (SDK extension)
export type CreateMessageResultWithTools = Infer<typeof CreateMessageResultWithToolsSchema>;

// Elicitation complete notification params (SDK extension)
export type ElicitationCompleteNotificationParams = Infer<typeof ElicitationCompleteNotificationParamsSchema>;

/**
 * CreateMessageRequestParams without tools - for backwards-compatible overload.
 * Excludes tools/toolChoice to indicate they should not be provided.
 */
export type CreateMessageRequestParamsBase = Omit<CreateMessageRequestParams, 'tools' | 'toolChoice'>;

/**
 * CreateMessageRequestParams with required tools - for tool-enabled overload.
 */
export interface CreateMessageRequestParamsWithTools extends CreateMessageRequestParams {
    tools: Tool[];
}

/**
 * @deprecated Use ResourceTemplateReference instead
 */
export type ResourceReference = ResourceTemplateReference;

export type CompleteRequestResourceTemplate = ExpandRecursively<
    CompleteRequest & { params: CompleteRequestParams & { ref: ResourceTemplateReference } }
>;
export type CompleteRequestPrompt = ExpandRecursively<CompleteRequest & { params: CompleteRequestParams & { ref: PromptReference } }>;

