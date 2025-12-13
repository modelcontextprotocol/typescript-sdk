import * as z from 'zod/v4';
import { AuthInfo } from './server/auth/types.js';

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
    CreateMessageResultSchema,
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
} from './generated/sdk.schemas.js';

// Alias RequestParamsSchema to BaseRequestParamsSchema for internal use
const BaseRequestParamsSchema = RequestParamsSchema;
// Alias NotificationParamsSchema to NotificationsParamsSchema (plural) for backwards compat
const NotificationsParamsSchema = NotificationParamsSchema;

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
    CreateMessageResultSchema,
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

// Note: RequestParamsSchema (aliased as BaseRequestParamsSchema) and
// TaskAugmentedRequestParamsSchema are re-exported from generated.
// They include RELATED_TASK_META_KEY in _meta, injected during pre-processing.

/**
 * Request metadata schema - used in _meta field of requests, notifications, and results.
 * This is extracted for reuse but the canonical definition is in RequestParamsSchema.
 */
const RequestMetaSchema = z.looseObject({
    progressToken: ProgressTokenSchema.optional(),
    [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
});

/**
 * Checks if a value is a valid TaskAugmentedRequestParams.
 * @param value - The value to check.
 *
 * @returns True if the value is a valid TaskAugmentedRequestParams, false otherwise.
 */
export const isTaskAugmentedRequestParams = (value: unknown): value is TaskAugmentedRequestParams =>
    TaskAugmentedRequestParamsSchema.safeParse(value).success;

// Note: RequestSchema, NotificationSchema, ResultSchema, and JSON-RPC schemas
// are re-exported from generated. They include proper _meta typing and .strict().

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

export const JSONRPCMessageSchema = z.union([
    JSONRPCRequestSchema,
    JSONRPCNotificationSchema,
    JSONRPCResultResponseSchema,
    JSONRPCErrorResponseSchema
]);
export const JSONRPCResponseSchema = z.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);

/* Empty result */
/**
 * A response that indicates success but carries no data.
 */
export const EmptyResultSchema = ResultSchema.strict();

// Note: CancelledNotificationParamsSchema is re-exported from generated.

/* Cancellation */
/**
 * This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
 *
 * Note: CancelledNotificationSchema is re-exported from generated.
 */

/* Initialization */
const FormElicitationCapabilitySchema = z.intersection(
    z.object({
        applyDefaults: z.boolean().optional()
    }),
    z.record(z.string(), z.unknown())
);

const ElicitationCapabilitySchema = z.preprocess(
    value => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (Object.keys(value as Record<string, unknown>).length === 0) {
                return { form: {} };
            }
        }
        return value;
    },
    z.intersection(
        z.object({
            form: FormElicitationCapabilitySchema.optional(),
            url: AssertObjectSchema.optional()
        }),
        z.record(z.string(), z.unknown()).optional()
    )
);

/**
 * Task capabilities for clients, indicating which request types support task creation.
 */
export const ClientTasksCapabilitySchema = z.looseObject({
    /**
     * Present if the client supports listing tasks.
     */
    list: AssertObjectSchema.optional(),
    /**
     * Present if the client supports cancelling tasks.
     */
    cancel: AssertObjectSchema.optional(),
    /**
     * Capabilities for task creation on specific request types.
     */
    requests: z
        .looseObject({
            /**
             * Task support for sampling requests.
             */
            sampling: z
                .looseObject({
                    createMessage: AssertObjectSchema.optional()
                })
                .optional(),
            /**
             * Task support for elicitation requests.
             */
            elicitation: z
                .looseObject({
                    create: AssertObjectSchema.optional()
                })
                .optional()
        })
        .optional()
});

/**
 * Task capabilities for servers, indicating which request types support task creation.
 */
export const ServerTasksCapabilitySchema = z.looseObject({
    /**
     * Present if the server supports listing tasks.
     */
    list: AssertObjectSchema.optional(),
    /**
     * Present if the server supports cancelling tasks.
     */
    cancel: AssertObjectSchema.optional(),
    /**
     * Capabilities for task creation on specific request types.
     */
    requests: z
        .looseObject({
            /**
             * Task support for tool requests.
             */
            tools: z
                .looseObject({
                    call: AssertObjectSchema.optional()
                })
                .optional()
        })
        .optional()
});

/**
 * Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
 */
export const ClientCapabilitiesSchema = z.object({
    /**
     * Experimental, non-standard capabilities that the client supports.
     */
    experimental: z.record(z.string(), AssertObjectSchema).optional(),
    /**
     * Present if the client supports sampling from an LLM.
     */
    sampling: z
        .object({
            /**
             * Present if the client supports context inclusion via includeContext parameter.
             * If not declared, servers SHOULD only use `includeContext: "none"` (or omit it).
             */
            context: AssertObjectSchema.optional(),
            /**
             * Present if the client supports tool use via tools and toolChoice parameters.
             */
            tools: AssertObjectSchema.optional()
        })
        .optional(),
    /**
     * Present if the client supports eliciting user input.
     */
    elicitation: ElicitationCapabilitySchema.optional(),
    /**
     * Present if the client supports listing roots.
     */
    roots: z
        .object({
            /**
             * Whether the client supports issuing notifications for changes to the roots list.
             */
            listChanged: z.boolean().optional()
        })
        .optional(),
    /**
     * Present if the client supports task creation.
     */
    tasks: ClientTasksCapabilitySchema.optional()
});

// Note: InitializeRequestParamsSchema, InitializeRequestSchema are re-exported from generated.

export const isInitializeRequest = (value: unknown): value is InitializeRequest => InitializeRequestSchema.safeParse(value).success;

/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
export const ServerCapabilitiesSchema = z.object({
    /**
     * Experimental, non-standard capabilities that the server supports.
     */
    experimental: z.record(z.string(), AssertObjectSchema).optional(),
    /**
     * Present if the server supports sending log messages to the client.
     */
    logging: AssertObjectSchema.optional(),
    /**
     * Present if the server supports sending completions to the client.
     */
    completions: AssertObjectSchema.optional(),
    /**
     * Present if the server offers any prompt templates.
     */
    prompts: z
        .object({
            /**
             * Whether this server supports issuing notifications for changes to the prompt list.
             */
            listChanged: z.boolean().optional()
        })
        .optional(),
    /**
     * Present if the server offers any resources to read.
     */
    resources: z
        .object({
            /**
             * Whether this server supports clients subscribing to resource updates.
             */
            subscribe: z.boolean().optional(),

            /**
             * Whether this server supports issuing notifications for changes to the resource list.
             */
            listChanged: z.boolean().optional()
        })
        .optional(),
    /**
     * Present if the server offers any tools to call.
     */
    tools: z
        .object({
            /**
             * Whether this server supports issuing notifications for changes to the tool list.
             */
            listChanged: z.boolean().optional()
        })
        .optional(),
    /**
     * Present if the server supports task creation.
     */
    tasks: ServerTasksCapabilitySchema.optional()
});

// Note: InitializeResultSchema, InitializedNotificationSchema are re-exported from generated.

export const isInitializedNotification = (value: unknown): value is InitializedNotification =>
    InitializedNotificationSchema.safeParse(value).success;

/* Ping */
// Note: PingRequestSchema is re-exported from generated.

/* Progress notifications */
export const ProgressSchema = z.object({
    /**
     * The progress thus far. This should increase every time progress is made, even if the total is unknown.
     */
    progress: z.number(),
    /**
     * Total number of items to process (or total progress required), if known.
     */
    total: z.optional(z.number()),
    /**
     * An optional message describing the current progress.
     */
    message: z.optional(z.string())
});

export const ProgressNotificationParamsSchema = z.object({
    ...NotificationsParamsSchema.shape,
    ...ProgressSchema.shape,
    /**
     * The progress token which was given in the initial request, used to associate this notification with the request that is proceeding.
     */
    progressToken: ProgressTokenSchema
});
// Note: ProgressNotificationSchema is re-exported from generated.

export const PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * An opaque token representing the current pagination position.
     * If provided, the server should return results starting after this cursor.
     */
    cursor: CursorSchema.optional()
});

/* Pagination */
// Note: PaginatedRequestSchema and PaginatedResultSchema are re-exported from generated.

/* Tasks */
/**
 * A pollable state object associated with a request.
 */
export const TaskSchema = z.object({
    taskId: z.string(),
    status: TaskStatusSchema,
    /**
     * Time in milliseconds to keep task results available after completion.
     * If null, the task has unlimited lifetime until manually cleaned up.
     */
    ttl: z.union([z.number(), z.null()]),
    /**
     * ISO 8601 timestamp when the task was created.
     */
    createdAt: z.string(),
    /**
     * ISO 8601 timestamp when the task was last updated.
     */
    lastUpdatedAt: z.string(),
    pollInterval: z.optional(z.number()),
    /**
     * Optional diagnostic message for failed tasks or other status information.
     */
    statusMessage: z.optional(z.string())
});

// Note: CreateTaskResultSchema, TaskStatusNotificationSchema, GetTaskResultSchema,
// GetTaskPayloadResultSchema, ListTasksResultSchema, CancelTaskResultSchema are re-exported from generated.

/**
 * Parameters for task status notification.
 */
export const TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);

/* Resources */
// Note: ResourceContentsSchema, TextResourceContentsSchema, BlobResourceContentsSchema
// are re-exported from generated with Base64 validation.

/**
 * A known resource that the server is capable of reading.
 */
export const ResourceSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    /**
     * The URI of this resource.
     */
    uri: z.string(),

    /**
     * A description of what this resource represents.
     *
     * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
     */
    description: z.optional(z.string()),

    /**
     * The MIME type of this resource, if known.
     */
    mimeType: z.optional(z.string()),

    /**
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.looseObject({}))
});

/**
 * A template description for resources available on the server.
 */
export const ResourceTemplateSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    /**
     * A URI template (according to RFC 6570) that can be used to construct resource URIs.
     */
    uriTemplate: z.string(),

    /**
     * A description of what this template is for.
     *
     * This can be used by clients to improve the LLM's understanding of available resources. It can be thought of like a "hint" to the model.
     */
    description: z.optional(z.string()),

    /**
     * The MIME type for all resources that match this template. This should only be included if all resources matching this template have the same type.
     */
    mimeType: z.optional(z.string()),

    /**
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.looseObject({}))
});

// Note: ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, SubscribeRequestSchema,
// UnsubscribeRequestSchema are re-exported from generated.

// Note: ListResourcesResultSchema, ListResourceTemplatesResultSchema are re-exported from generated.

export const ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The URI of the resource to read. The URI can use any protocol; it is up to the server how to interpret it.
     *
     * @format uri
     */
    uri: z.string()
});

/**
 * Parameters for a `resources/read` request.
 */
export const ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;

// Note: ReadResourceRequestSchema, ReadResourceResultSchema, ResourceListChangedNotificationSchema
// are re-exported from generated.

export const SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
export const UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;

/**
 * Parameters for a `notifications/resources/updated` notification.
 */
export const ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
     */
    uri: z.string()
});

// Note: ResourceUpdatedNotificationSchema is re-exported from generated.

/* Prompts */
/**
 * Describes an argument that a prompt can accept.
 */
export const PromptArgumentSchema = z.object({
    /**
     * The name of the argument.
     */
    name: z.string(),
    /**
     * A human-readable description of the argument.
     */
    description: z.optional(z.string()),
    /**
     * Whether this argument must be provided.
     */
    required: z.optional(z.boolean())
});

/**
 * A prompt or prompt template that the server offers.
 */
export const PromptSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    /**
     * An optional description of what this prompt provides
     */
    description: z.optional(z.string()),
    /**
     * A list of arguments to use for templating the prompt.
     */
    arguments: z.optional(z.array(PromptArgumentSchema)),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.looseObject({}))
});

// Note: ListPromptsRequestSchema, GetPromptRequestSchema are re-exported from generated.

// Note: ListPromptsResultSchema is re-exported from generated.

/**
 * Parameters for a `prompts/get` request.
 */
export const GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The name of the prompt or prompt template.
     */
    name: z.string(),
    /**
     * Arguments to use for templating the prompt.
     */
    arguments: z.record(z.string(), z.string()).optional()
});

// Note: TextContentSchema, ImageContentSchema, AudioContentSchema are re-exported
// from generated with Base64 validation for data fields.

/**
 * A tool call request from an assistant (LLM).
 * Represents the assistant's request to use a tool.
 */
export const ToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    /**
     * The name of the tool to invoke.
     * Must match a tool name from the request's tools array.
     */
    name: z.string(),
    /**
     * Unique identifier for this tool call.
     * Used to correlate with ToolResultContent in subsequent messages.
     */
    id: z.string(),
    /**
     * Arguments to pass to the tool.
     * Must conform to the tool's inputSchema.
     */
    input: z.record(z.string(), z.unknown()),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

// Note: EmbeddedResourceSchema, ResourceLinkSchema, ContentBlockSchema are re-exported from generated.

/**
 * Describes a message returned as part of a prompt.
 */
export const PromptMessageSchema = z.object({
    role: RoleSchema,
    content: ContentBlockSchema
});

// Note: GetPromptResultSchema, PromptListChangedNotificationSchema are re-exported from generated.

/* Tools */
/**
 * Additional properties describing a Tool to clients.
 *
 * NOTE: all properties in ToolAnnotations are **hints**.
 * They are not guaranteed to provide a faithful description of
 * tool behavior (including descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on ToolAnnotations
 * received from untrusted servers.
 *
 * Note: ToolAnnotationsSchema and ToolExecutionSchema are re-exported from generated schemas.
 */

/**
 * Definition for a tool the client can call.
 */
export const ToolSchema = z.object({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    /**
     * A human-readable description of the tool.
     */
    description: z.string().optional(),
    /**
     * A JSON Schema 2020-12 object defining the expected parameters for the tool.
     * Must have type: 'object' at the root level per MCP spec.
     */
    inputSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), AssertObjectSchema).optional(),
            required: z.array(z.string()).optional()
        })
        .catchall(z.unknown()),
    /**
     * An optional JSON Schema 2020-12 object defining the structure of the tool's output
     * returned in the structuredContent field of a CallToolResult.
     * Must have type: 'object' at the root level per MCP spec.
     */
    outputSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), AssertObjectSchema).optional(),
            required: z.array(z.string()).optional()
        })
        .catchall(z.unknown())
        .optional(),
    /**
     * Optional additional tool information.
     */
    annotations: ToolAnnotationsSchema.optional(),
    /**
     * Execution-related properties for this tool.
     */
    execution: ToolExecutionSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

// Note: ListToolsRequestSchema is re-exported from generated.

// Note: ListToolsResultSchema, CallToolResultSchema, CallToolRequestParamsSchema,
// CallToolRequestSchema, ToolListChangedNotificationSchema are re-exported from generated.

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
/**
 * Parameters for a `logging/setLevel` request.
 */
export const SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as notifications/logging/message.
     */
    level: LoggingLevelSchema
});
// Note: SetLevelRequestSchema, LoggingMessageNotificationSchema are re-exported from generated.

/**
 * Parameters for a `notifications/message` notification.
 */
export const LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The severity of this log message.
     */
    level: LoggingLevelSchema,
    /**
     * An optional name of the logger issuing this message.
     */
    logger: z.string().optional(),
    /**
     * The data to be logged, such as a string message or an object. Any JSON serializable type is allowed here.
     */
    data: z.unknown()
});

/* Sampling */
/**
 * The result of a tool execution, provided by the user (server).
 * Represents the outcome of invoking a tool requested via ToolUseContent.
 */
export const ToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string().describe('The unique identifier for the corresponding tool call.'),
    content: z.array(ContentBlockSchema).default([]),
    structuredContent: z.object({}).loose().optional(),
    isError: z.boolean().optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * Basic content types for sampling responses (without tool use).
 * Used for backwards-compatible CreateMessageResult when tools are not used.
 */
export const SamplingContentSchema = z.discriminatedUnion('type', [TextContentSchema, ImageContentSchema, AudioContentSchema]);

/**
 * Content block types allowed in sampling messages.
 * This includes text, image, audio, tool use requests, and tool results.
 */
export const SamplingMessageContentBlockSchema = z.discriminatedUnion('type', [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolUseContentSchema,
    ToolResultContentSchema
]);

// Note: SamplingMessageSchema, CreateMessageRequestParamsSchema, CreateMessageRequestSchema,
// CreateMessageResultSchema are re-exported from generated.

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
// Note: BooleanSchemaSchema and NumberSchemaSchema are re-exported from generated schemas.
// StringSchemaSchema differs slightly (enum vs union for format) so kept here.

/**
 * Primitive schema definition for string fields.
 */
export const StringSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    default: z.string().optional()
});

// Note: Enum schemas (UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema,
// LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, UntitledMultiSelectEnumSchemaSchema,
// TitledMultiSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema, EnumSchemaSchema,
// PrimitiveSchemaDefinitionSchema) are re-exported from generated.

// Note: ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema, ElicitRequestParamsSchema,
// ElicitRequestSchema, ElicitResultSchema, ElicitationCompleteNotificationSchema are re-exported from generated.

/**
 * Parameters for a `notifications/elicitation/complete` notification.
 *
 * @category notifications/elicitation/complete
 */
export const ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The ID of the elicitation that completed.
     */
    elicitationId: z.string()
});

/* Autocomplete */
// Note: ResourceTemplateReferenceSchema, PromptReferenceSchema are re-exported from generated.

/**
 * @deprecated Use ResourceTemplateReferenceSchema instead
 */
export const ResourceReferenceSchema = ResourceTemplateReferenceSchema;

// Note: CompleteRequestParamsSchema, CompleteRequestSchema, CompleteResultSchema
// are re-exported from generated.

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
// Note: RootSchema, ListRootsRequestSchema, ListRootsResultSchema, RootsListChangedNotificationSchema
// are re-exported from generated.

/* Client/Server message types */
// Note: ClientRequestSchema, ClientNotificationSchema, ClientResultSchema,
// ServerRequestSchema, ServerNotificationSchema, ServerResultSchema are re-exported from generated.

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

/* JSON-RPC types */
export type ProgressToken = Infer<typeof ProgressTokenSchema>;
export type Cursor = Infer<typeof CursorSchema>;
export type Request = Infer<typeof RequestSchema>;
export type TaskAugmentedRequestParams = Infer<typeof TaskAugmentedRequestParamsSchema>;
export type RequestMeta = Infer<typeof RequestMetaSchema>;
export type Notification = Infer<typeof NotificationSchema>;
export type Result = Infer<typeof ResultSchema>;
export type RequestId = Infer<typeof RequestIdSchema>;
export type JSONRPCRequest = Infer<typeof JSONRPCRequestSchema>;
export type JSONRPCNotification = Infer<typeof JSONRPCNotificationSchema>;
export type JSONRPCResponse = Infer<typeof JSONRPCResponseSchema>;
export type JSONRPCErrorResponse = Infer<typeof JSONRPCErrorResponseSchema>;
export type JSONRPCResultResponse = Infer<typeof JSONRPCResultResponseSchema>;

export type JSONRPCMessage = Infer<typeof JSONRPCMessageSchema>;
export type RequestParams = Infer<typeof BaseRequestParamsSchema>;
export type NotificationParams = Infer<typeof NotificationsParamsSchema>;

/* Empty result */
export type EmptyResult = Infer<typeof EmptyResultSchema>;

/* Cancellation */
export type CancelledNotificationParams = Infer<typeof CancelledNotificationParamsSchema>;
export type CancelledNotification = Infer<typeof CancelledNotificationSchema>;

/* Base Metadata */
export type Icon = Infer<typeof IconSchema>;
export type Icons = Infer<typeof IconsSchema>;
export type BaseMetadata = Infer<typeof BaseMetadataSchema>;
export type Annotations = Infer<typeof AnnotationsSchema>;
export type Role = Infer<typeof RoleSchema>;

/* Initialization */
export type Implementation = Infer<typeof ImplementationSchema>;
export type ClientCapabilities = Infer<typeof ClientCapabilitiesSchema>;
export type InitializeRequestParams = Infer<typeof InitializeRequestParamsSchema>;
export type InitializeRequest = Infer<typeof InitializeRequestSchema>;
export type ServerCapabilities = Infer<typeof ServerCapabilitiesSchema>;
export type InitializeResult = Infer<typeof InitializeResultSchema>;
export type InitializedNotification = Infer<typeof InitializedNotificationSchema>;

/* Ping */
export type PingRequest = Infer<typeof PingRequestSchema>;

/* Progress notifications */
export type Progress = Infer<typeof ProgressSchema>;
export type ProgressNotificationParams = Infer<typeof ProgressNotificationParamsSchema>;
export type ProgressNotification = Infer<typeof ProgressNotificationSchema>;

/* Tasks */
export type Task = Infer<typeof TaskSchema>;
export type TaskStatus = Infer<typeof TaskStatusSchema>;
export type TaskCreationParams = Infer<typeof TaskCreationParamsSchema>;
export type TaskMetadata = Infer<typeof TaskMetadataSchema>;
export type RelatedTaskMetadata = Infer<typeof RelatedTaskMetadataSchema>;
export type CreateTaskResult = Infer<typeof CreateTaskResultSchema>;
export type TaskStatusNotificationParams = Infer<typeof TaskStatusNotificationParamsSchema>;
export type TaskStatusNotification = Infer<typeof TaskStatusNotificationSchema>;
export type GetTaskRequest = Infer<typeof GetTaskRequestSchema>;
export type GetTaskResult = Infer<typeof GetTaskResultSchema>;
export type GetTaskPayloadRequest = Infer<typeof GetTaskPayloadRequestSchema>;
export type ListTasksRequest = Infer<typeof ListTasksRequestSchema>;
export type ListTasksResult = Infer<typeof ListTasksResultSchema>;
export type CancelTaskRequest = Infer<typeof CancelTaskRequestSchema>;
export type CancelTaskResult = Infer<typeof CancelTaskResultSchema>;
export type GetTaskPayloadResult = Infer<typeof GetTaskPayloadResultSchema>;

/* Pagination */
export type PaginatedRequestParams = Infer<typeof PaginatedRequestParamsSchema>;
export type PaginatedRequest = Infer<typeof PaginatedRequestSchema>;
export type PaginatedResult = Infer<typeof PaginatedResultSchema>;

/* Resources */
export type ResourceContents = Infer<typeof ResourceContentsSchema>;
export type TextResourceContents = Infer<typeof TextResourceContentsSchema>;
export type BlobResourceContents = Infer<typeof BlobResourceContentsSchema>;
export type Resource = Infer<typeof ResourceSchema>;
export type ResourceTemplate = Infer<typeof ResourceTemplateSchema>;
export type ListResourcesRequest = Infer<typeof ListResourcesRequestSchema>;
export type ListResourcesResult = Infer<typeof ListResourcesResultSchema>;
export type ListResourceTemplatesRequest = Infer<typeof ListResourceTemplatesRequestSchema>;
export type ListResourceTemplatesResult = Infer<typeof ListResourceTemplatesResultSchema>;
export type ResourceRequestParams = Infer<typeof ResourceRequestParamsSchema>;
export type ReadResourceRequestParams = Infer<typeof ReadResourceRequestParamsSchema>;
export type ReadResourceRequest = Infer<typeof ReadResourceRequestSchema>;
export type ReadResourceResult = Infer<typeof ReadResourceResultSchema>;
export type ResourceListChangedNotification = Infer<typeof ResourceListChangedNotificationSchema>;
export type SubscribeRequestParams = Infer<typeof SubscribeRequestParamsSchema>;
export type SubscribeRequest = Infer<typeof SubscribeRequestSchema>;
export type UnsubscribeRequestParams = Infer<typeof UnsubscribeRequestParamsSchema>;
export type UnsubscribeRequest = Infer<typeof UnsubscribeRequestSchema>;
export type ResourceUpdatedNotificationParams = Infer<typeof ResourceUpdatedNotificationParamsSchema>;
export type ResourceUpdatedNotification = Infer<typeof ResourceUpdatedNotificationSchema>;

/* Prompts */
export type PromptArgument = Infer<typeof PromptArgumentSchema>;
export type Prompt = Infer<typeof PromptSchema>;
export type ListPromptsRequest = Infer<typeof ListPromptsRequestSchema>;
export type ListPromptsResult = Infer<typeof ListPromptsResultSchema>;
export type GetPromptRequestParams = Infer<typeof GetPromptRequestParamsSchema>;
export type GetPromptRequest = Infer<typeof GetPromptRequestSchema>;
export type TextContent = Infer<typeof TextContentSchema>;
export type ImageContent = Infer<typeof ImageContentSchema>;
export type AudioContent = Infer<typeof AudioContentSchema>;
export type ToolUseContent = Infer<typeof ToolUseContentSchema>;
export type ToolResultContent = Infer<typeof ToolResultContentSchema>;
export type EmbeddedResource = Infer<typeof EmbeddedResourceSchema>;
export type ResourceLink = Infer<typeof ResourceLinkSchema>;
export type ContentBlock = Infer<typeof ContentBlockSchema>;
export type PromptMessage = Infer<typeof PromptMessageSchema>;
export type GetPromptResult = Infer<typeof GetPromptResultSchema>;
export type PromptListChangedNotification = Infer<typeof PromptListChangedNotificationSchema>;

/* Tools */
export type ToolAnnotations = Infer<typeof ToolAnnotationsSchema>;
export type ToolExecution = Infer<typeof ToolExecutionSchema>;
export type Tool = Infer<typeof ToolSchema>;
export type ListToolsRequest = Infer<typeof ListToolsRequestSchema>;
export type ListToolsResult = Infer<typeof ListToolsResultSchema>;
export type CallToolRequestParams = Infer<typeof CallToolRequestParamsSchema>;
export type CallToolResult = Infer<typeof CallToolResultSchema>;
export type CompatibilityCallToolResult = Infer<typeof CompatibilityCallToolResultSchema>;
export type CallToolRequest = Infer<typeof CallToolRequestSchema>;
export type ToolListChangedNotification = Infer<typeof ToolListChangedNotificationSchema>;

/* Logging */
export type LoggingLevel = Infer<typeof LoggingLevelSchema>;
export type SetLevelRequestParams = Infer<typeof SetLevelRequestParamsSchema>;
export type SetLevelRequest = Infer<typeof SetLevelRequestSchema>;
export type LoggingMessageNotificationParams = Infer<typeof LoggingMessageNotificationParamsSchema>;
export type LoggingMessageNotification = Infer<typeof LoggingMessageNotificationSchema>;

/* Sampling */
export type ToolChoice = Infer<typeof ToolChoiceSchema>;
export type ModelHint = Infer<typeof ModelHintSchema>;
export type ModelPreferences = Infer<typeof ModelPreferencesSchema>;
export type SamplingContent = Infer<typeof SamplingContentSchema>;
export type SamplingMessageContentBlock = Infer<typeof SamplingMessageContentBlockSchema>;
export type SamplingMessage = Infer<typeof SamplingMessageSchema>;
export type CreateMessageRequestParams = Infer<typeof CreateMessageRequestParamsSchema>;
export type CreateMessageRequest = Infer<typeof CreateMessageRequestSchema>;
export type CreateMessageResult = Infer<typeof CreateMessageResultSchema>;
export type CreateMessageResultWithTools = Infer<typeof CreateMessageResultWithToolsSchema>;

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

/* Elicitation */
export type BooleanSchema = Infer<typeof BooleanSchemaSchema>;
export type StringSchema = Infer<typeof StringSchemaSchema>;
export type NumberSchema = Infer<typeof NumberSchemaSchema>;

export type EnumSchema = Infer<typeof EnumSchemaSchema>;
export type UntitledSingleSelectEnumSchema = Infer<typeof UntitledSingleSelectEnumSchemaSchema>;
export type TitledSingleSelectEnumSchema = Infer<typeof TitledSingleSelectEnumSchemaSchema>;
export type LegacyTitledEnumSchema = Infer<typeof LegacyTitledEnumSchemaSchema>;
export type UntitledMultiSelectEnumSchema = Infer<typeof UntitledMultiSelectEnumSchemaSchema>;
export type TitledMultiSelectEnumSchema = Infer<typeof TitledMultiSelectEnumSchemaSchema>;
export type SingleSelectEnumSchema = Infer<typeof SingleSelectEnumSchemaSchema>;
export type MultiSelectEnumSchema = Infer<typeof MultiSelectEnumSchemaSchema>;

export type PrimitiveSchemaDefinition = Infer<typeof PrimitiveSchemaDefinitionSchema>;
export type ElicitRequestParams = Infer<typeof ElicitRequestParamsSchema>;
export type ElicitRequestFormParams = Infer<typeof ElicitRequestFormParamsSchema>;
export type ElicitRequestURLParams = Infer<typeof ElicitRequestURLParamsSchema>;
export type ElicitRequest = Infer<typeof ElicitRequestSchema>;
export type ElicitationCompleteNotificationParams = Infer<typeof ElicitationCompleteNotificationParamsSchema>;
export type ElicitationCompleteNotification = Infer<typeof ElicitationCompleteNotificationSchema>;
export type ElicitResult = Infer<typeof ElicitResultSchema>;

/* Autocomplete */
export type ResourceTemplateReference = Infer<typeof ResourceTemplateReferenceSchema>;
/**
 * @deprecated Use ResourceTemplateReference instead
 */
export type ResourceReference = ResourceTemplateReference;
export type PromptReference = Infer<typeof PromptReferenceSchema>;
export type CompleteRequestParams = Infer<typeof CompleteRequestParamsSchema>;
export type CompleteRequest = Infer<typeof CompleteRequestSchema>;
export type CompleteRequestResourceTemplate = ExpandRecursively<
    CompleteRequest & { params: CompleteRequestParams & { ref: ResourceTemplateReference } }
>;
export type CompleteRequestPrompt = ExpandRecursively<CompleteRequest & { params: CompleteRequestParams & { ref: PromptReference } }>;
export type CompleteResult = Infer<typeof CompleteResultSchema>;

/* Roots */
export type Root = Infer<typeof RootSchema>;
export type ListRootsRequest = Infer<typeof ListRootsRequestSchema>;
export type ListRootsResult = Infer<typeof ListRootsResultSchema>;
export type RootsListChangedNotification = Infer<typeof RootsListChangedNotificationSchema>;

/* Client messages */
export type ClientRequest = Infer<typeof ClientRequestSchema>;
export type ClientNotification = Infer<typeof ClientNotificationSchema>;
export type ClientResult = Infer<typeof ClientResultSchema>;

/* Server messages */
export type ServerRequest = Infer<typeof ServerRequestSchema>;
export type ServerNotification = Infer<typeof ServerNotificationSchema>;
export type ServerResult = Infer<typeof ServerResultSchema>;

// =============================================================================
// Type Compatibility Verification with Generated Types
// =============================================================================
// This section verifies that manually-defined types match generated types.
// If there's a mismatch, TypeScript will error here, catching drift early.
// Once verified, these can be progressively replaced with re-exports.

import type * as Generated from './generated/sdk.types.js';

// Helper types for bidirectional assignability checks
type AssertAssignable<T, U> = T extends U ? true : false;
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// Verify primitive types
type _CheckProgressToken = AssertEqual<ProgressToken, Generated.ProgressToken>;
type _CheckCursor = AssertEqual<Cursor, Generated.Cursor>;
type _CheckRequestId = AssertEqual<RequestId, Generated.RequestId>;

// Verify core message types
type _CheckRequest = AssertAssignable<Request, Generated.Request>;
type _CheckNotification = AssertAssignable<Notification, Generated.Notification>;
type _CheckResult = AssertAssignable<Result, Generated.Result>;

// Verify JSON-RPC types
type _CheckJSONRPCRequest = AssertEqual<JSONRPCRequest, Generated.JSONRPCRequest>;
type _CheckJSONRPCNotification = AssertEqual<JSONRPCNotification, Generated.JSONRPCNotification>;
type _CheckJSONRPCResponse = AssertEqual<JSONRPCResponse, Generated.JSONRPCResponse>;

// Verify commonly used types
type _CheckTool = AssertAssignable<Tool, Generated.Tool>;
type _CheckResource = AssertAssignable<Resource, Generated.Resource>;
type _CheckPrompt = AssertAssignable<Prompt, Generated.Prompt>;
type _CheckImplementation = AssertEqual<Implementation, Generated.Implementation>;

// Verify content types
type _CheckTextContent = AssertEqual<TextContent, Generated.TextContent>;
type _CheckImageContent = AssertEqual<ImageContent, Generated.ImageContent>;
type _CheckAudioContent = AssertEqual<AudioContent, Generated.AudioContent>;

// Verify request/notification types (these should extend Request/Notification, not JSONRPC*)
type _CheckInitializeRequest = AssertAssignable<InitializeRequest, Generated.InitializeRequest>;
type _CheckCallToolRequest = AssertAssignable<CallToolRequest, Generated.CallToolRequest>;
type _CheckCancelledNotification = AssertAssignable<CancelledNotification, Generated.CancelledNotification>;
