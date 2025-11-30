"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskStatusNotificationParamsSchema = exports.CreateTaskResultSchema = exports.TaskSchema = exports.PaginatedResultSchema = exports.PaginatedRequestSchema = exports.PaginatedRequestParamsSchema = exports.ProgressNotificationSchema = exports.ProgressNotificationParamsSchema = exports.ProgressSchema = exports.PingRequestSchema = exports.isInitializedNotification = exports.InitializedNotificationSchema = exports.InitializeResultSchema = exports.ServerCapabilitiesSchema = exports.isInitializeRequest = exports.InitializeRequestSchema = exports.InitializeRequestParamsSchema = exports.ClientCapabilitiesSchema = exports.ServerTasksCapabilitySchema = exports.ClientTasksCapabilitySchema = exports.ImplementationSchema = exports.BaseMetadataSchema = exports.IconsSchema = exports.IconSchema = exports.CancelledNotificationSchema = exports.CancelledNotificationParamsSchema = exports.EmptyResultSchema = exports.JSONRPCMessageSchema = exports.isJSONRPCError = exports.JSONRPCErrorSchema = exports.ErrorCode = exports.isJSONRPCResponse = exports.JSONRPCResponseSchema = exports.isJSONRPCNotification = exports.JSONRPCNotificationSchema = exports.isJSONRPCRequest = exports.JSONRPCRequestSchema = exports.RequestIdSchema = exports.ResultSchema = exports.NotificationSchema = exports.RequestSchema = exports.RelatedTaskMetadataSchema = exports.TaskCreationParamsSchema = exports.CursorSchema = exports.ProgressTokenSchema = exports.JSONRPC_VERSION = exports.RELATED_TASK_META_KEY = exports.SUPPORTED_PROTOCOL_VERSIONS = exports.DEFAULT_NEGOTIATED_PROTOCOL_VERSION = exports.LATEST_PROTOCOL_VERSION = void 0;
exports.CallToolResultSchema = exports.ListToolsResultSchema = exports.ListToolsRequestSchema = exports.ToolSchema = exports.ToolExecutionSchema = exports.ToolAnnotationsSchema = exports.PromptListChangedNotificationSchema = exports.GetPromptResultSchema = exports.PromptMessageSchema = exports.ContentBlockSchema = exports.ResourceLinkSchema = exports.EmbeddedResourceSchema = exports.ToolUseContentSchema = exports.AudioContentSchema = exports.ImageContentSchema = exports.TextContentSchema = exports.GetPromptRequestSchema = exports.GetPromptRequestParamsSchema = exports.ListPromptsResultSchema = exports.ListPromptsRequestSchema = exports.PromptSchema = exports.PromptArgumentSchema = exports.ResourceUpdatedNotificationSchema = exports.ResourceUpdatedNotificationParamsSchema = exports.UnsubscribeRequestSchema = exports.UnsubscribeRequestParamsSchema = exports.SubscribeRequestSchema = exports.SubscribeRequestParamsSchema = exports.ResourceListChangedNotificationSchema = exports.ReadResourceResultSchema = exports.ReadResourceRequestSchema = exports.ReadResourceRequestParamsSchema = exports.ResourceRequestParamsSchema = exports.ListResourceTemplatesResultSchema = exports.ListResourceTemplatesRequestSchema = exports.ListResourcesResultSchema = exports.ListResourcesRequestSchema = exports.ResourceTemplateSchema = exports.ResourceSchema = exports.BlobResourceContentsSchema = exports.TextResourceContentsSchema = exports.ResourceContentsSchema = exports.CancelTaskResultSchema = exports.CancelTaskRequestSchema = exports.ListTasksResultSchema = exports.ListTasksRequestSchema = exports.GetTaskPayloadRequestSchema = exports.GetTaskResultSchema = exports.GetTaskRequestSchema = exports.TaskStatusNotificationSchema = void 0;
exports.ClientResultSchema = exports.ClientNotificationSchema = exports.ClientRequestSchema = exports.RootsListChangedNotificationSchema = exports.ListRootsResultSchema = exports.ListRootsRequestSchema = exports.RootSchema = exports.CompleteResultSchema = exports.CompleteRequestSchema = exports.CompleteRequestParamsSchema = exports.PromptReferenceSchema = exports.ResourceReferenceSchema = exports.ResourceTemplateReferenceSchema = exports.ElicitResultSchema = exports.ElicitationCompleteNotificationSchema = exports.ElicitationCompleteNotificationParamsSchema = exports.ElicitRequestSchema = exports.ElicitRequestParamsSchema = exports.ElicitRequestURLParamsSchema = exports.ElicitRequestFormParamsSchema = exports.PrimitiveSchemaDefinitionSchema = exports.EnumSchemaSchema = exports.MultiSelectEnumSchemaSchema = exports.TitledMultiSelectEnumSchemaSchema = exports.UntitledMultiSelectEnumSchemaSchema = exports.SingleSelectEnumSchemaSchema = exports.LegacyTitledEnumSchemaSchema = exports.TitledSingleSelectEnumSchemaSchema = exports.UntitledSingleSelectEnumSchemaSchema = exports.NumberSchemaSchema = exports.StringSchemaSchema = exports.BooleanSchemaSchema = exports.CreateMessageResultSchema = exports.CreateMessageRequestSchema = exports.CreateMessageRequestParamsSchema = exports.SamplingMessageSchema = exports.SamplingMessageContentBlockSchema = exports.ToolResultContentSchema = exports.ToolChoiceSchema = exports.ModelPreferencesSchema = exports.ModelHintSchema = exports.LoggingMessageNotificationSchema = exports.LoggingMessageNotificationParamsSchema = exports.SetLevelRequestSchema = exports.SetLevelRequestParamsSchema = exports.LoggingLevelSchema = exports.ToolListChangedNotificationSchema = exports.CallToolRequestSchema = exports.CallToolRequestParamsSchema = exports.CompatibilityCallToolResultSchema = void 0;
exports.UrlElicitationRequiredError = exports.McpError = exports.ServerResultSchema = exports.ServerNotificationSchema = exports.ServerRequestSchema = void 0;
exports.assertCompleteRequestPrompt = assertCompleteRequestPrompt;
exports.assertCompleteRequestResourceTemplate = assertCompleteRequestResourceTemplate;
const z = __importStar(require("zod/v4"));
exports.LATEST_PROTOCOL_VERSION = '2025-06-18';
exports.DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
exports.SUPPORTED_PROTOCOL_VERSIONS = [exports.LATEST_PROTOCOL_VERSION, '2025-03-26', '2024-11-05', '2024-10-07'];
exports.RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';
/* JSON-RPC types */
exports.JSONRPC_VERSION = '2.0';
/**
 * Assert 'object' type schema.
 *
 * @internal
 */
const AssertObjectSchema = z.custom((v) => v !== null && (typeof v === 'object' || typeof v === 'function'));
/**
 * A progress token, used to associate progress notifications with the original request.
 */
exports.ProgressTokenSchema = z.union([z.string(), z.number().int()]);
/**
 * An opaque token used to represent a cursor for pagination.
 */
exports.CursorSchema = z.string();
/**
 * Task creation parameters, used to ask that the server create a task to represent a request.
 */
exports.TaskCreationParamsSchema = z.looseObject({
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
/**
 * Task association metadata, used to signal which task a message originated from.
 */
exports.RelatedTaskMetadataSchema = z.looseObject({
    taskId: z.string()
});
const RequestMetaSchema = z.looseObject({
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: exports.ProgressTokenSchema.optional(),
    /**
     * If specified, this request is related to the provided task.
     */
    [exports.RELATED_TASK_META_KEY]: exports.RelatedTaskMetadataSchema.optional()
});
/**
 * Common params for any request.
 */
const BaseRequestParamsSchema = z.looseObject({
    /**
     * If specified, the caller is requesting that the receiver create a task to represent the request.
     * Task creation parameters are now at the top level instead of in _meta.
     */
    task: exports.TaskCreationParamsSchema.optional(),
    /**
     * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
     */
    _meta: RequestMetaSchema.optional()
});
exports.RequestSchema = z.object({
    method: z.string(),
    params: BaseRequestParamsSchema.optional()
});
const NotificationsParamsSchema = z.looseObject({
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z
        .object({
        /**
         * If specified, this notification is related to the provided task.
         */
        [exports.RELATED_TASK_META_KEY]: z.optional(exports.RelatedTaskMetadataSchema)
    })
        .passthrough()
        .optional()
});
exports.NotificationSchema = z.object({
    method: z.string(),
    params: NotificationsParamsSchema.optional()
});
exports.ResultSchema = z.looseObject({
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z
        .looseObject({
        /**
         * If specified, this result is related to the provided task.
         */
        [exports.RELATED_TASK_META_KEY]: exports.RelatedTaskMetadataSchema.optional()
    })
        .optional()
});
/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
exports.RequestIdSchema = z.union([z.string(), z.number().int()]);
/**
 * A request that expects a response.
 */
exports.JSONRPCRequestSchema = z
    .object({
    jsonrpc: z.literal(exports.JSONRPC_VERSION),
    id: exports.RequestIdSchema,
    ...exports.RequestSchema.shape
})
    .strict();
const isJSONRPCRequest = (value) => exports.JSONRPCRequestSchema.safeParse(value).success;
exports.isJSONRPCRequest = isJSONRPCRequest;
/**
 * A notification which does not expect a response.
 */
exports.JSONRPCNotificationSchema = z
    .object({
    jsonrpc: z.literal(exports.JSONRPC_VERSION),
    ...exports.NotificationSchema.shape
})
    .strict();
const isJSONRPCNotification = (value) => exports.JSONRPCNotificationSchema.safeParse(value).success;
exports.isJSONRPCNotification = isJSONRPCNotification;
/**
 * A successful (non-error) response to a request.
 */
exports.JSONRPCResponseSchema = z
    .object({
    jsonrpc: z.literal(exports.JSONRPC_VERSION),
    id: exports.RequestIdSchema,
    result: exports.ResultSchema
})
    .strict();
const isJSONRPCResponse = (value) => exports.JSONRPCResponseSchema.safeParse(value).success;
exports.isJSONRPCResponse = isJSONRPCResponse;
/**
 * Error codes defined by the JSON-RPC specification.
 */
var ErrorCode;
(function (ErrorCode) {
    // SDK error codes
    ErrorCode[ErrorCode["ConnectionClosed"] = -32000] = "ConnectionClosed";
    ErrorCode[ErrorCode["RequestTimeout"] = -32001] = "RequestTimeout";
    // Standard JSON-RPC error codes
    ErrorCode[ErrorCode["ParseError"] = -32700] = "ParseError";
    ErrorCode[ErrorCode["InvalidRequest"] = -32600] = "InvalidRequest";
    ErrorCode[ErrorCode["MethodNotFound"] = -32601] = "MethodNotFound";
    ErrorCode[ErrorCode["InvalidParams"] = -32602] = "InvalidParams";
    ErrorCode[ErrorCode["InternalError"] = -32603] = "InternalError";
    // MCP-specific error codes
    ErrorCode[ErrorCode["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
/**
 * A response to a request that indicates an error occurred.
 */
exports.JSONRPCErrorSchema = z
    .object({
    jsonrpc: z.literal(exports.JSONRPC_VERSION),
    id: exports.RequestIdSchema,
    error: z.object({
        /**
         * The error type that occurred.
         */
        code: z.number().int(),
        /**
         * A short description of the error. The message SHOULD be limited to a concise single sentence.
         */
        message: z.string(),
        /**
         * Additional information about the error. The value of this member is defined by the sender (e.g. detailed error information, nested errors etc.).
         */
        data: z.optional(z.unknown())
    })
})
    .strict();
const isJSONRPCError = (value) => exports.JSONRPCErrorSchema.safeParse(value).success;
exports.isJSONRPCError = isJSONRPCError;
exports.JSONRPCMessageSchema = z.union([exports.JSONRPCRequestSchema, exports.JSONRPCNotificationSchema, exports.JSONRPCResponseSchema, exports.JSONRPCErrorSchema]);
/* Empty result */
/**
 * A response that indicates success but carries no data.
 */
exports.EmptyResultSchema = exports.ResultSchema.strict();
exports.CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The ID of the request to cancel.
     *
     * This MUST correspond to the ID of a request previously issued in the same direction.
     */
    requestId: exports.RequestIdSchema,
    /**
     * An optional string describing the reason for the cancellation. This MAY be logged or presented to the user.
     */
    reason: z.string().optional()
});
/* Cancellation */
/**
 * This notification can be sent by either side to indicate that it is cancelling a previously-issued request.
 *
 * The request SHOULD still be in-flight, but due to communication latency, it is always possible that this notification MAY arrive after the request has already finished.
 *
 * This notification indicates that the result will be unused, so any associated processing SHOULD cease.
 *
 * A client MUST NOT attempt to cancel its `initialize` request.
 */
exports.CancelledNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/cancelled'),
    params: exports.CancelledNotificationParamsSchema
});
/* Base Metadata */
/**
 * Icon schema for use in tools, prompts, resources, and implementations.
 */
exports.IconSchema = z.object({
    /**
     * URL or data URI for the icon.
     */
    src: z.string(),
    /**
     * Optional MIME type for the icon.
     */
    mimeType: z.string().optional(),
    /**
     * Optional array of strings that specify sizes at which the icon can be used.
     * Each string should be in WxH format (e.g., `"48x48"`, `"96x96"`) or `"any"` for scalable formats like SVG.
     *
     * If not provided, the client should assume that the icon can be used at any size.
     */
    sizes: z.array(z.string()).optional()
});
/**
 * Base schema to add `icons` property.
 *
 */
exports.IconsSchema = z.object({
    /**
     * Optional set of sized icons that the client can display in a user interface.
     *
     * Clients that support rendering icons MUST support at least the following MIME types:
     * - `image/png` - PNG images (safe, universal compatibility)
     * - `image/jpeg` (and `image/jpg`) - JPEG images (safe, universal compatibility)
     *
     * Clients that support rendering icons SHOULD also support:
     * - `image/svg+xml` - SVG images (scalable but requires security precautions)
     * - `image/webp` - WebP images (modern, efficient format)
     */
    icons: z.array(exports.IconSchema).optional()
});
/**
 * Base metadata interface for common properties across resources, tools, prompts, and implementations.
 */
exports.BaseMetadataSchema = z.object({
    /** Intended for programmatic or logical use, but used as a display name in past specs or fallback */
    name: z.string(),
    /**
     * Intended for UI and end-user contexts — optimized to be human-readable and easily understood,
     * even by those unfamiliar with domain-specific terminology.
     *
     * If not provided, the name should be used for display (except for Tool,
     * where `annotations.title` should be given precedence over using `name`,
     * if present).
     */
    title: z.string().optional()
});
/* Initialization */
/**
 * Describes the name and version of an MCP implementation.
 */
exports.ImplementationSchema = exports.BaseMetadataSchema.extend({
    ...exports.BaseMetadataSchema.shape,
    ...exports.IconsSchema.shape,
    version: z.string(),
    /**
     * An optional URL of the website for this implementation.
     */
    websiteUrl: z.string().optional()
});
const FormElicitationCapabilitySchema = z.intersection(z.object({
    applyDefaults: z.boolean().optional()
}), z.record(z.string(), z.unknown()));
const ElicitationCapabilitySchema = z.preprocess(value => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (Object.keys(value).length === 0) {
            return { form: {} };
        }
    }
    return value;
}, z.intersection(z.object({
    form: FormElicitationCapabilitySchema.optional(),
    url: AssertObjectSchema.optional()
}), z.record(z.string(), z.unknown()).optional()));
/**
 * Task capabilities for clients, indicating which request types support task creation.
 */
exports.ClientTasksCapabilitySchema = z
    .object({
    /**
     * Present if the client supports listing tasks.
     */
    list: z.optional(z.object({}).passthrough()),
    /**
     * Present if the client supports cancelling tasks.
     */
    cancel: z.optional(z.object({}).passthrough()),
    /**
     * Capabilities for task creation on specific request types.
     */
    requests: z.optional(z
        .object({
        /**
         * Task support for sampling requests.
         */
        sampling: z.optional(z
            .object({
            createMessage: z.optional(z.object({}).passthrough())
        })
            .passthrough()),
        /**
         * Task support for elicitation requests.
         */
        elicitation: z.optional(z
            .object({
            create: z.optional(z.object({}).passthrough())
        })
            .passthrough())
    })
        .passthrough())
})
    .passthrough();
/**
 * Task capabilities for servers, indicating which request types support task creation.
 */
exports.ServerTasksCapabilitySchema = z
    .object({
    /**
     * Present if the server supports listing tasks.
     */
    list: z.optional(z.object({}).passthrough()),
    /**
     * Present if the server supports cancelling tasks.
     */
    cancel: z.optional(z.object({}).passthrough()),
    /**
     * Capabilities for task creation on specific request types.
     */
    requests: z.optional(z
        .object({
        /**
         * Task support for tool requests.
         */
        tools: z.optional(z
            .object({
            call: z.optional(z.object({}).passthrough())
        })
            .passthrough())
    })
        .passthrough())
})
    .passthrough();
/**
 * Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
 */
exports.ClientCapabilitiesSchema = z.object({
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
    tasks: z.optional(exports.ClientTasksCapabilitySchema)
});
exports.InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The latest version of the Model Context Protocol that the client supports. The client MAY decide to support older versions as well.
     */
    protocolVersion: z.string(),
    capabilities: exports.ClientCapabilitiesSchema,
    clientInfo: exports.ImplementationSchema
});
/**
 * This request is sent from the client to the server when it first connects, asking it to begin initialization.
 */
exports.InitializeRequestSchema = exports.RequestSchema.extend({
    method: z.literal('initialize'),
    params: exports.InitializeRequestParamsSchema
});
const isInitializeRequest = (value) => exports.InitializeRequestSchema.safeParse(value).success;
exports.isInitializeRequest = isInitializeRequest;
/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
exports.ServerCapabilitiesSchema = z
    .object({
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
    prompts: z.optional(z.object({
        /**
         * Whether this server supports issuing notifications for changes to the prompt list.
         */
        listChanged: z.optional(z.boolean())
    })),
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
    tasks: z.optional(exports.ServerTasksCapabilitySchema)
})
    .passthrough();
/**
 * After receiving an initialize request from the client, the server sends this response.
 */
exports.InitializeResultSchema = exports.ResultSchema.extend({
    /**
     * The version of the Model Context Protocol that the server wants to use. This may not match the version that the client requested. If the client cannot support this version, it MUST disconnect.
     */
    protocolVersion: z.string(),
    capabilities: exports.ServerCapabilitiesSchema,
    serverInfo: exports.ImplementationSchema,
    /**
     * Instructions describing how to use the server and its features.
     *
     * This can be used by clients to improve the LLM's understanding of available tools, resources, etc. It can be thought of like a "hint" to the model. For example, this information MAY be added to the system prompt.
     */
    instructions: z.string().optional()
});
/**
 * This notification is sent from the client to the server after initialization has finished.
 */
exports.InitializedNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/initialized')
});
const isInitializedNotification = (value) => exports.InitializedNotificationSchema.safeParse(value).success;
exports.isInitializedNotification = isInitializedNotification;
/* Ping */
/**
 * A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
 */
exports.PingRequestSchema = exports.RequestSchema.extend({
    method: z.literal('ping')
});
/* Progress notifications */
exports.ProgressSchema = z.object({
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
exports.ProgressNotificationParamsSchema = z.object({
    ...NotificationsParamsSchema.shape,
    ...exports.ProgressSchema.shape,
    /**
     * The progress token which was given in the initial request, used to associate this notification with the request that is proceeding.
     */
    progressToken: exports.ProgressTokenSchema
});
/**
 * An out-of-band notification used to inform the receiver of a progress update for a long-running request.
 *
 * @category notifications/progress
 */
exports.ProgressNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/progress'),
    params: exports.ProgressNotificationParamsSchema
});
exports.PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * An opaque token representing the current pagination position.
     * If provided, the server should return results starting after this cursor.
     */
    cursor: exports.CursorSchema.optional()
});
/* Pagination */
exports.PaginatedRequestSchema = exports.RequestSchema.extend({
    params: exports.PaginatedRequestParamsSchema.optional()
});
exports.PaginatedResultSchema = exports.ResultSchema.extend({
    /**
     * An opaque token representing the pagination position after the last returned result.
     * If present, there may be more results available.
     */
    nextCursor: z.optional(exports.CursorSchema)
});
/* Tasks */
/**
 * A pollable state object associated with a request.
 */
exports.TaskSchema = z.object({
    taskId: z.string(),
    status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
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
/**
 * Result returned when a task is created, containing the task data wrapped in a task field.
 */
exports.CreateTaskResultSchema = exports.ResultSchema.extend({
    task: exports.TaskSchema
});
/**
 * Parameters for task status notification.
 */
exports.TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(exports.TaskSchema);
/**
 * A notification sent when a task's status changes.
 */
exports.TaskStatusNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/tasks/status'),
    params: exports.TaskStatusNotificationParamsSchema
});
/**
 * A request to get the state of a specific task.
 */
exports.GetTaskRequestSchema = exports.RequestSchema.extend({
    method: z.literal('tasks/get'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});
/**
 * The response to a tasks/get request.
 */
exports.GetTaskResultSchema = exports.ResultSchema.merge(exports.TaskSchema);
/**
 * A request to get the result of a specific task.
 */
exports.GetTaskPayloadRequestSchema = exports.RequestSchema.extend({
    method: z.literal('tasks/result'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});
/**
 * A request to list tasks.
 */
exports.ListTasksRequestSchema = exports.PaginatedRequestSchema.extend({
    method: z.literal('tasks/list')
});
/**
 * The response to a tasks/list request.
 */
exports.ListTasksResultSchema = exports.PaginatedResultSchema.extend({
    tasks: z.array(exports.TaskSchema)
});
/**
 * A request to cancel a specific task.
 */
exports.CancelTaskRequestSchema = exports.RequestSchema.extend({
    method: z.literal('tasks/cancel'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});
/**
 * The response to a tasks/cancel request.
 */
exports.CancelTaskResultSchema = exports.ResultSchema.merge(exports.TaskSchema);
/* Resources */
/**
 * The contents of a specific resource or sub-resource.
 */
exports.ResourceContentsSchema = z.object({
    /**
     * The URI of this resource.
     */
    uri: z.string(),
    /**
     * The MIME type of this resource, if known.
     */
    mimeType: z.optional(z.string()),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
exports.TextResourceContentsSchema = exports.ResourceContentsSchema.extend({
    /**
     * The text of the item. This must only be set if the item can actually be represented as text (not binary data).
     */
    text: z.string()
});
/**
 * A Zod schema for validating Base64 strings that is more performant and
 * robust for very large inputs than the default regex-based check. It avoids
 * stack overflows by using the native `atob` function for validation.
 */
const Base64Schema = z.string().refine(val => {
    try {
        // atob throws a DOMException if the string contains characters
        // that are not part of the Base64 character set.
        atob(val);
        return true;
    }
    catch (_a) {
        return false;
    }
}, { message: 'Invalid Base64 string' });
exports.BlobResourceContentsSchema = exports.ResourceContentsSchema.extend({
    /**
     * A base64-encoded string representing the binary data of the item.
     */
    blob: Base64Schema
});
/**
 * A known resource that the server is capable of reading.
 */
exports.ResourceSchema = z.object({
    ...exports.BaseMetadataSchema.shape,
    ...exports.IconsSchema.shape,
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
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.looseObject({}))
});
/**
 * A template description for resources available on the server.
 */
exports.ResourceTemplateSchema = z.object({
    ...exports.BaseMetadataSchema.shape,
    ...exports.IconsSchema.shape,
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
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.looseObject({}))
});
/**
 * Sent from the client to request a list of resources the server has.
 */
exports.ListResourcesRequestSchema = exports.PaginatedRequestSchema.extend({
    method: z.literal('resources/list')
});
/**
 * The server's response to a resources/list request from the client.
 */
exports.ListResourcesResultSchema = exports.PaginatedResultSchema.extend({
    resources: z.array(exports.ResourceSchema)
});
/**
 * Sent from the client to request a list of resource templates the server has.
 */
exports.ListResourceTemplatesRequestSchema = exports.PaginatedRequestSchema.extend({
    method: z.literal('resources/templates/list')
});
/**
 * The server's response to a resources/templates/list request from the client.
 */
exports.ListResourceTemplatesResultSchema = exports.PaginatedResultSchema.extend({
    resourceTemplates: z.array(exports.ResourceTemplateSchema)
});
exports.ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({
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
exports.ReadResourceRequestParamsSchema = exports.ResourceRequestParamsSchema;
/**
 * Sent from the client to the server, to read a specific resource URI.
 */
exports.ReadResourceRequestSchema = exports.RequestSchema.extend({
    method: z.literal('resources/read'),
    params: exports.ReadResourceRequestParamsSchema
});
/**
 * The server's response to a resources/read request from the client.
 */
exports.ReadResourceResultSchema = exports.ResultSchema.extend({
    contents: z.array(z.union([exports.TextResourceContentsSchema, exports.BlobResourceContentsSchema]))
});
/**
 * An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
 */
exports.ResourceListChangedNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/resources/list_changed')
});
exports.SubscribeRequestParamsSchema = exports.ResourceRequestParamsSchema;
/**
 * Sent from the client to request resources/updated notifications from the server whenever a particular resource changes.
 */
exports.SubscribeRequestSchema = exports.RequestSchema.extend({
    method: z.literal('resources/subscribe'),
    params: exports.SubscribeRequestParamsSchema
});
exports.UnsubscribeRequestParamsSchema = exports.ResourceRequestParamsSchema;
/**
 * Sent from the client to request cancellation of resources/updated notifications from the server. This should follow a previous resources/subscribe request.
 */
exports.UnsubscribeRequestSchema = exports.RequestSchema.extend({
    method: z.literal('resources/unsubscribe'),
    params: exports.UnsubscribeRequestParamsSchema
});
/**
 * Parameters for a `notifications/resources/updated` notification.
 */
exports.ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
     */
    uri: z.string()
});
/**
 * A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a resources/subscribe request.
 */
exports.ResourceUpdatedNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/resources/updated'),
    params: exports.ResourceUpdatedNotificationParamsSchema
});
/* Prompts */
/**
 * Describes an argument that a prompt can accept.
 */
exports.PromptArgumentSchema = z.object({
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
exports.PromptSchema = z.object({
    ...exports.BaseMetadataSchema.shape,
    ...exports.IconsSchema.shape,
    /**
     * An optional description of what this prompt provides
     */
    description: z.optional(z.string()),
    /**
     * A list of arguments to use for templating the prompt.
     */
    arguments: z.optional(z.array(exports.PromptArgumentSchema)),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.looseObject({}))
});
/**
 * Sent from the client to request a list of prompts and prompt templates the server has.
 */
exports.ListPromptsRequestSchema = exports.PaginatedRequestSchema.extend({
    method: z.literal('prompts/list')
});
/**
 * The server's response to a prompts/list request from the client.
 */
exports.ListPromptsResultSchema = exports.PaginatedResultSchema.extend({
    prompts: z.array(exports.PromptSchema)
});
/**
 * Parameters for a `prompts/get` request.
 */
exports.GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The name of the prompt or prompt template.
     */
    name: z.string(),
    /**
     * Arguments to use for templating the prompt.
     */
    arguments: z.record(z.string(), z.string()).optional()
});
/**
 * Used by the client to get a prompt provided by the server.
 */
exports.GetPromptRequestSchema = exports.RequestSchema.extend({
    method: z.literal('prompts/get'),
    params: exports.GetPromptRequestParamsSchema
});
/**
 * Text provided to or from an LLM.
 */
exports.TextContentSchema = z.object({
    type: z.literal('text'),
    /**
     * The text content of the message.
     */
    text: z.string(),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
/**
 * An image provided to or from an LLM.
 */
exports.ImageContentSchema = z.object({
    type: z.literal('image'),
    /**
     * The base64-encoded image data.
     */
    data: Base64Schema,
    /**
     * The MIME type of the image. Different providers may support different image types.
     */
    mimeType: z.string(),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
/**
 * An Audio provided to or from an LLM.
 */
exports.AudioContentSchema = z.object({
    type: z.literal('audio'),
    /**
     * The base64-encoded audio data.
     */
    data: Base64Schema,
    /**
     * The MIME type of the audio. Different providers may support different audio types.
     */
    mimeType: z.string(),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
/**
 * A tool call request from an assistant (LLM).
 * Represents the assistant's request to use a tool.
 */
exports.ToolUseContentSchema = z
    .object({
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
    input: z.object({}).passthrough(),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.object({}).passthrough())
})
    .passthrough();
/**
 * The contents of a resource, embedded into a prompt or tool call result.
 */
exports.EmbeddedResourceSchema = z.object({
    type: z.literal('resource'),
    resource: z.union([exports.TextResourceContentsSchema, exports.BlobResourceContentsSchema]),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
/**
 * A resource that the server is capable of reading, included in a prompt or tool call result.
 *
 * Note: resource links returned by tools are not guaranteed to appear in the results of `resources/list` requests.
 */
exports.ResourceLinkSchema = exports.ResourceSchema.extend({
    type: z.literal('resource_link')
});
/**
 * A content block that can be used in prompts and tool results.
 */
exports.ContentBlockSchema = z.union([
    exports.TextContentSchema,
    exports.ImageContentSchema,
    exports.AudioContentSchema,
    exports.ResourceLinkSchema,
    exports.EmbeddedResourceSchema
]);
/**
 * Describes a message returned as part of a prompt.
 */
exports.PromptMessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: exports.ContentBlockSchema
});
/**
 * The server's response to a prompts/get request from the client.
 */
exports.GetPromptResultSchema = exports.ResultSchema.extend({
    /**
     * An optional description for the prompt.
     */
    description: z.optional(z.string()),
    messages: z.array(exports.PromptMessageSchema)
});
/**
 * An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
exports.PromptListChangedNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/prompts/list_changed')
});
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
 */
exports.ToolAnnotationsSchema = z.object({
    /**
     * A human-readable title for the tool.
     */
    title: z.string().optional(),
    /**
     * If true, the tool does not modify its environment.
     *
     * Default: false
     */
    readOnlyHint: z.boolean().optional(),
    /**
     * If true, the tool may perform destructive updates to its environment.
     * If false, the tool performs only additive updates.
     *
     * (This property is meaningful only when `readOnlyHint == false`)
     *
     * Default: true
     */
    destructiveHint: z.boolean().optional(),
    /**
     * If true, calling the tool repeatedly with the same arguments
     * will have no additional effect on the its environment.
     *
     * (This property is meaningful only when `readOnlyHint == false`)
     *
     * Default: false
     */
    idempotentHint: z.boolean().optional(),
    /**
     * If true, this tool may interact with an "open world" of external
     * entities. If false, the tool's domain of interaction is closed.
     * For example, the world of a web search tool is open, whereas that
     * of a memory tool is not.
     *
     * Default: true
     */
    openWorldHint: z.boolean().optional()
});
/**
 * Execution-related properties for a tool.
 */
exports.ToolExecutionSchema = z.object({
    /**
     * Indicates the tool's preference for task-augmented execution.
     * - "required": Clients MUST invoke the tool as a task
     * - "optional": Clients MAY invoke the tool as a task or normal request
     * - "forbidden": Clients MUST NOT attempt to invoke the tool as a task
     *
     * If not present, defaults to "forbidden".
     */
    taskSupport: z.enum(['required', 'optional', 'forbidden']).optional()
});
/**
 * Definition for a tool the client can call.
 */
exports.ToolSchema = z.object({
    ...exports.BaseMetadataSchema.shape,
    ...exports.IconsSchema.shape,
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
    annotations: z.optional(exports.ToolAnnotationsSchema),
    /**
     * Execution-related properties for this tool.
     */
    execution: z.optional(exports.ToolExecutionSchema),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
/**
 * Sent from the client to request a list of tools the server has.
 */
exports.ListToolsRequestSchema = exports.PaginatedRequestSchema.extend({
    method: z.literal('tools/list')
});
/**
 * The server's response to a tools/list request from the client.
 */
exports.ListToolsResultSchema = exports.PaginatedResultSchema.extend({
    tools: z.array(exports.ToolSchema)
});
/**
 * The server's response to a tool call.
 */
exports.CallToolResultSchema = exports.ResultSchema.extend({
    /**
     * A list of content objects that represent the result of the tool call.
     *
     * If the Tool does not define an outputSchema, this field MUST be present in the result.
     * For backwards compatibility, this field is always present, but it may be empty.
     */
    content: z.array(exports.ContentBlockSchema).default([]),
    /**
     * An object containing structured tool output.
     *
     * If the Tool defines an outputSchema, this field MUST be present in the result, and contain a JSON object that matches the schema.
     */
    structuredContent: z.record(z.string(), z.unknown()).optional(),
    /**
     * Whether the tool call ended in an error.
     *
     * If not set, this is assumed to be false (the call was successful).
     *
     * Any errors that originate from the tool SHOULD be reported inside the result
     * object, with `isError` set to true, _not_ as an MCP protocol-level error
     * response. Otherwise, the LLM would not be able to see that an error occurred
     * and self-correct.
     *
     * However, any errors in _finding_ the tool, an error indicating that the
     * server does not support tool calls, or any other exceptional conditions,
     * should be reported as an MCP error response.
     */
    isError: z.optional(z.boolean())
});
/**
 * CallToolResultSchema extended with backwards compatibility to protocol version 2024-10-07.
 */
exports.CompatibilityCallToolResultSchema = exports.CallToolResultSchema.or(exports.ResultSchema.extend({
    toolResult: z.unknown()
}));
/**
 * Parameters for a `tools/call` request.
 */
exports.CallToolRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The name of the tool to call.
     */
    name: z.string(),
    /**
     * Arguments to pass to the tool.
     */
    arguments: z.optional(z.record(z.string(), z.unknown()))
});
/**
 * Used by the client to invoke a tool provided by the server.
 */
exports.CallToolRequestSchema = exports.RequestSchema.extend({
    method: z.literal('tools/call'),
    params: exports.CallToolRequestParamsSchema
});
/**
 * An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
exports.ToolListChangedNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/tools/list_changed')
});
/* Logging */
/**
 * The severity of a log message.
 */
exports.LoggingLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);
/**
 * Parameters for a `logging/setLevel` request.
 */
exports.SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as notifications/logging/message.
     */
    level: exports.LoggingLevelSchema
});
/**
 * A request from the client to the server, to enable or adjust logging.
 */
exports.SetLevelRequestSchema = exports.RequestSchema.extend({
    method: z.literal('logging/setLevel'),
    params: exports.SetLevelRequestParamsSchema
});
/**
 * Parameters for a `notifications/message` notification.
 */
exports.LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The severity of this log message.
     */
    level: exports.LoggingLevelSchema,
    /**
     * An optional name of the logger issuing this message.
     */
    logger: z.string().optional(),
    /**
     * The data to be logged, such as a string message or an object. Any JSON serializable type is allowed here.
     */
    data: z.unknown()
});
/**
 * Notification of a log message passed from server to client. If no logging/setLevel request has been sent from the client, the server MAY decide which messages to send automatically.
 */
exports.LoggingMessageNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/message'),
    params: exports.LoggingMessageNotificationParamsSchema
});
/* Sampling */
/**
 * Hints to use for model selection.
 */
exports.ModelHintSchema = z.object({
    /**
     * A hint for a model name.
     */
    name: z.string().optional()
});
/**
 * The server's preferences for model selection, requested of the client during sampling.
 */
exports.ModelPreferencesSchema = z.object({
    /**
     * Optional hints to use for model selection.
     */
    hints: z.optional(z.array(exports.ModelHintSchema)),
    /**
     * How much to prioritize cost when selecting a model.
     */
    costPriority: z.optional(z.number().min(0).max(1)),
    /**
     * How much to prioritize sampling speed (latency) when selecting a model.
     */
    speedPriority: z.optional(z.number().min(0).max(1)),
    /**
     * How much to prioritize intelligence and capabilities when selecting a model.
     */
    intelligencePriority: z.optional(z.number().min(0).max(1))
});
/**
 * Controls tool usage behavior in sampling requests.
 */
exports.ToolChoiceSchema = z.object({
    /**
     * Controls when tools are used:
     * - "auto": Model decides whether to use tools (default)
     * - "required": Model MUST use at least one tool before completing
     * - "none": Model MUST NOT use any tools
     */
    mode: z.optional(z.enum(['auto', 'required', 'none']))
});
/**
 * The result of a tool execution, provided by the user (server).
 * Represents the outcome of invoking a tool requested via ToolUseContent.
 */
exports.ToolResultContentSchema = z
    .object({
    type: z.literal('tool_result'),
    toolUseId: z.string().describe('The unique identifier for the corresponding tool call.'),
    content: z.array(exports.ContentBlockSchema).default([]),
    structuredContent: z.object({}).passthrough().optional(),
    isError: z.optional(z.boolean()),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.object({}).passthrough())
})
    .passthrough();
/**
 * Content block types allowed in sampling messages.
 * This includes text, image, audio, tool use requests, and tool results.
 */
exports.SamplingMessageContentBlockSchema = z.discriminatedUnion('type', [
    exports.TextContentSchema,
    exports.ImageContentSchema,
    exports.AudioContentSchema,
    exports.ToolUseContentSchema,
    exports.ToolResultContentSchema
]);
/**
 * Describes a message issued to or received from an LLM API.
 */
exports.SamplingMessageSchema = z
    .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([exports.SamplingMessageContentBlockSchema, z.array(exports.SamplingMessageContentBlockSchema)]),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.optional(z.object({}).passthrough())
})
    .passthrough();
/**
 * Parameters for a `sampling/createMessage` request.
 */
exports.CreateMessageRequestParamsSchema = BaseRequestParamsSchema.extend({
    messages: z.array(exports.SamplingMessageSchema),
    /**
     * The server's preferences for which model to select. The client MAY modify or omit this request.
     */
    modelPreferences: exports.ModelPreferencesSchema.optional(),
    /**
     * An optional system prompt the server wants to use for sampling. The client MAY modify or omit this prompt.
     */
    systemPrompt: z.string().optional(),
    /**
     * A request to include context from one or more MCP servers (including the caller), to be attached to the prompt.
     * The client MAY ignore this request.
     *
     * Default is "none". Values "thisServer" and "allServers" are soft-deprecated. Servers SHOULD only use these values if the client
     * declares ClientCapabilities.sampling.context. These values may be removed in future spec releases.
     */
    includeContext: z.enum(['none', 'thisServer', 'allServers']).optional(),
    temperature: z.number().optional(),
    /**
     * The requested maximum number of tokens to sample (to prevent runaway completions).
     *
     * The client MAY choose to sample fewer tokens than the requested maximum.
     */
    maxTokens: z.number().int(),
    stopSequences: z.array(z.string()).optional(),
    /**
     * Optional metadata to pass through to the LLM provider. The format of this metadata is provider-specific.
     */
    metadata: AssertObjectSchema.optional(),
    /**
     * Tools that the model may use during generation.
     * The client MUST return an error if this field is provided but ClientCapabilities.sampling.tools is not declared.
     */
    tools: z.optional(z.array(exports.ToolSchema)),
    /**
     * Controls how the model uses tools.
     * The client MUST return an error if this field is provided but ClientCapabilities.sampling.tools is not declared.
     * Default is `{ mode: "auto" }`.
     */
    toolChoice: z.optional(exports.ToolChoiceSchema)
});
/**
 * A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
 */
exports.CreateMessageRequestSchema = exports.RequestSchema.extend({
    method: z.literal('sampling/createMessage'),
    params: exports.CreateMessageRequestParamsSchema
});
/**
 * The client's response to a sampling/create_message request from the server. The client should inform the user before returning the sampled message, to allow them to inspect the response (human in the loop) and decide whether to allow the server to see it.
 */
exports.CreateMessageResultSchema = exports.ResultSchema.extend({
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
    role: z.enum(['user', 'assistant']),
    /**
     * Response content. May be ToolUseContent if stopReason is "toolUse".
     */
    content: z.union([exports.SamplingMessageContentBlockSchema, z.array(exports.SamplingMessageContentBlockSchema)])
});
/* Elicitation */
/**
 * Primitive schema definition for boolean fields.
 */
exports.BooleanSchemaSchema = z.object({
    type: z.literal('boolean'),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional()
});
/**
 * Primitive schema definition for string fields.
 */
exports.StringSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(),
    default: z.string().optional()
});
/**
 * Primitive schema definition for number fields.
 */
exports.NumberSchemaSchema = z.object({
    type: z.enum(['number', 'integer']),
    title: z.string().optional(),
    description: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional()
});
/**
 * Schema for single-selection enumeration without display titles for options.
 */
exports.UntitledSingleSelectEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()),
    default: z.string().optional()
});
/**
 * Schema for single-selection enumeration with display titles for each option.
 */
exports.TitledSingleSelectEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(z.object({
        const: z.string(),
        title: z.string()
    })),
    default: z.string().optional()
});
/**
 * Use TitledSingleSelectEnumSchema instead.
 * This interface will be removed in a future version.
 */
exports.LegacyTitledEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional()
});
// Combined single selection enumeration
exports.SingleSelectEnumSchemaSchema = z.union([exports.UntitledSingleSelectEnumSchemaSchema, exports.TitledSingleSelectEnumSchemaSchema]);
/**
 * Schema for multiple-selection enumeration without display titles for options.
 */
exports.UntitledMultiSelectEnumSchemaSchema = z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    items: z.object({
        type: z.literal('string'),
        enum: z.array(z.string())
    }),
    default: z.array(z.string()).optional()
});
/**
 * Schema for multiple-selection enumeration with display titles for each option.
 */
exports.TitledMultiSelectEnumSchemaSchema = z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    items: z.object({
        anyOf: z.array(z.object({
            const: z.string(),
            title: z.string()
        }))
    }),
    default: z.array(z.string()).optional()
});
/**
 * Combined schema for multiple-selection enumeration
 */
exports.MultiSelectEnumSchemaSchema = z.union([exports.UntitledMultiSelectEnumSchemaSchema, exports.TitledMultiSelectEnumSchemaSchema]);
/**
 * Primitive schema definition for enum fields.
 */
exports.EnumSchemaSchema = z.union([exports.LegacyTitledEnumSchemaSchema, exports.SingleSelectEnumSchemaSchema, exports.MultiSelectEnumSchemaSchema]);
/**
 * Union of all primitive schema definitions.
 */
exports.PrimitiveSchemaDefinitionSchema = z.union([exports.EnumSchemaSchema, exports.BooleanSchemaSchema, exports.StringSchemaSchema, exports.NumberSchemaSchema]);
/**
 * Parameters for an `elicitation/create` request for form-based elicitation.
 */
exports.ElicitRequestFormParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The elicitation mode.
     *
     * Optional for backward compatibility. Clients MUST treat missing mode as "form".
     */
    mode: z.literal('form').optional(),
    /**
     * The message to present to the user describing what information is being requested.
     */
    message: z.string(),
    /**
     * A restricted subset of JSON Schema.
     * Only top-level properties are allowed, without nesting.
     */
    requestedSchema: z.object({
        type: z.literal('object'),
        properties: z.record(z.string(), exports.PrimitiveSchemaDefinitionSchema),
        required: z.array(z.string()).optional()
    })
});
/**
 * Parameters for an `elicitation/create` request for URL-based elicitation.
 */
exports.ElicitRequestURLParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The elicitation mode.
     */
    mode: z.literal('url'),
    /**
     * The message to present to the user explaining why the interaction is needed.
     */
    message: z.string(),
    /**
     * The ID of the elicitation, which must be unique within the context of the server.
     * The client MUST treat this ID as an opaque value.
     */
    elicitationId: z.string(),
    /**
     * The URL that the user should navigate to.
     */
    url: z.string().url()
});
/**
 * The parameters for a request to elicit additional information from the user via the client.
 */
exports.ElicitRequestParamsSchema = z.union([exports.ElicitRequestFormParamsSchema, exports.ElicitRequestURLParamsSchema]);
/**
 * A request from the server to elicit user input via the client.
 * The client should present the message and form fields to the user (form mode)
 * or navigate to a URL (URL mode).
 */
exports.ElicitRequestSchema = exports.RequestSchema.extend({
    method: z.literal('elicitation/create'),
    params: exports.ElicitRequestParamsSchema
});
/**
 * Parameters for a `notifications/elicitation/complete` notification.
 *
 * @category notifications/elicitation/complete
 */
exports.ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The ID of the elicitation that completed.
     */
    elicitationId: z.string()
});
/**
 * A notification from the server to the client, informing it of a completion of an out-of-band elicitation request.
 *
 * @category notifications/elicitation/complete
 */
exports.ElicitationCompleteNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/elicitation/complete'),
    params: exports.ElicitationCompleteNotificationParamsSchema
});
/**
 * The client's response to an elicitation/create request from the server.
 */
exports.ElicitResultSchema = exports.ResultSchema.extend({
    /**
     * The user action in response to the elicitation.
     * - "accept": User submitted the form/confirmed the action
     * - "decline": User explicitly decline the action
     * - "cancel": User dismissed without making an explicit choice
     */
    action: z.enum(['accept', 'decline', 'cancel']),
    /**
     * The submitted form data, only present when action is "accept".
     * Contains values matching the requested schema.
     */
    content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
});
/* Autocomplete */
/**
 * A reference to a resource or resource template definition.
 */
exports.ResourceTemplateReferenceSchema = z.object({
    type: z.literal('ref/resource'),
    /**
     * The URI or URI template of the resource.
     */
    uri: z.string()
});
/**
 * @deprecated Use ResourceTemplateReferenceSchema instead
 */
exports.ResourceReferenceSchema = exports.ResourceTemplateReferenceSchema;
/**
 * Identifies a prompt.
 */
exports.PromptReferenceSchema = z.object({
    type: z.literal('ref/prompt'),
    /**
     * The name of the prompt or prompt template
     */
    name: z.string()
});
/**
 * Parameters for a `completion/complete` request.
 */
exports.CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
    ref: z.union([exports.PromptReferenceSchema, exports.ResourceTemplateReferenceSchema]),
    /**
     * The argument's information
     */
    argument: z.object({
        /**
         * The name of the argument
         */
        name: z.string(),
        /**
         * The value of the argument to use for completion matching.
         */
        value: z.string()
    }),
    context: z
        .object({
        /**
         * Previously-resolved variables in a URI template or prompt.
         */
        arguments: z.record(z.string(), z.string()).optional()
    })
        .optional()
});
/**
 * A request from the client to the server, to ask for completion options.
 */
exports.CompleteRequestSchema = exports.RequestSchema.extend({
    method: z.literal('completion/complete'),
    params: exports.CompleteRequestParamsSchema
});
function assertCompleteRequestPrompt(request) {
    if (request.params.ref.type !== 'ref/prompt') {
        throw new TypeError(`Expected CompleteRequestPrompt, but got ${request.params.ref.type}`);
    }
    void request;
}
function assertCompleteRequestResourceTemplate(request) {
    if (request.params.ref.type !== 'ref/resource') {
        throw new TypeError(`Expected CompleteRequestResourceTemplate, but got ${request.params.ref.type}`);
    }
    void request;
}
/**
 * The server's response to a completion/complete request
 */
exports.CompleteResultSchema = exports.ResultSchema.extend({
    completion: z.looseObject({
        /**
         * An array of completion values. Must not exceed 100 items.
         */
        values: z.array(z.string()).max(100),
        /**
         * The total number of completion options available. This can exceed the number of values actually sent in the response.
         */
        total: z.optional(z.number().int()),
        /**
         * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
         */
        hasMore: z.optional(z.boolean())
    })
});
/* Roots */
/**
 * Represents a root directory or file that the server can operate on.
 */
exports.RootSchema = z.object({
    /**
     * The URI identifying the root. This *must* start with file:// for now.
     */
    uri: z.string().startsWith('file://'),
    /**
     * An optional name for the root.
     */
    name: z.string().optional(),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on _meta usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});
/**
 * Sent from the server to request a list of root URIs from the client.
 */
exports.ListRootsRequestSchema = exports.RequestSchema.extend({
    method: z.literal('roots/list')
});
/**
 * The client's response to a roots/list request from the server.
 */
exports.ListRootsResultSchema = exports.ResultSchema.extend({
    roots: z.array(exports.RootSchema)
});
/**
 * A notification from the client to the server, informing it that the list of roots has changed.
 */
exports.RootsListChangedNotificationSchema = exports.NotificationSchema.extend({
    method: z.literal('notifications/roots/list_changed')
});
/* Client messages */
exports.ClientRequestSchema = z.union([
    exports.PingRequestSchema,
    exports.InitializeRequestSchema,
    exports.CompleteRequestSchema,
    exports.SetLevelRequestSchema,
    exports.GetPromptRequestSchema,
    exports.ListPromptsRequestSchema,
    exports.ListResourcesRequestSchema,
    exports.ListResourceTemplatesRequestSchema,
    exports.ReadResourceRequestSchema,
    exports.SubscribeRequestSchema,
    exports.UnsubscribeRequestSchema,
    exports.CallToolRequestSchema,
    exports.ListToolsRequestSchema,
    exports.GetTaskRequestSchema,
    exports.GetTaskPayloadRequestSchema,
    exports.ListTasksRequestSchema
]);
exports.ClientNotificationSchema = z.union([
    exports.CancelledNotificationSchema,
    exports.ProgressNotificationSchema,
    exports.InitializedNotificationSchema,
    exports.RootsListChangedNotificationSchema,
    exports.TaskStatusNotificationSchema
]);
exports.ClientResultSchema = z.union([
    exports.EmptyResultSchema,
    exports.CreateMessageResultSchema,
    exports.ElicitResultSchema,
    exports.ListRootsResultSchema,
    exports.GetTaskResultSchema,
    exports.ListTasksResultSchema,
    exports.CreateTaskResultSchema
]);
/* Server messages */
exports.ServerRequestSchema = z.union([
    exports.PingRequestSchema,
    exports.CreateMessageRequestSchema,
    exports.ElicitRequestSchema,
    exports.ListRootsRequestSchema,
    exports.GetTaskRequestSchema,
    exports.GetTaskPayloadRequestSchema,
    exports.ListTasksRequestSchema
]);
exports.ServerNotificationSchema = z.union([
    exports.CancelledNotificationSchema,
    exports.ProgressNotificationSchema,
    exports.LoggingMessageNotificationSchema,
    exports.ResourceUpdatedNotificationSchema,
    exports.ResourceListChangedNotificationSchema,
    exports.ToolListChangedNotificationSchema,
    exports.PromptListChangedNotificationSchema,
    exports.TaskStatusNotificationSchema,
    exports.ElicitationCompleteNotificationSchema
]);
exports.ServerResultSchema = z.union([
    exports.EmptyResultSchema,
    exports.InitializeResultSchema,
    exports.CompleteResultSchema,
    exports.GetPromptResultSchema,
    exports.ListPromptsResultSchema,
    exports.ListResourcesResultSchema,
    exports.ListResourceTemplatesResultSchema,
    exports.ReadResourceResultSchema,
    exports.CallToolResultSchema,
    exports.ListToolsResultSchema,
    exports.GetTaskResultSchema,
    exports.ListTasksResultSchema,
    exports.CreateTaskResultSchema
]);
class McpError extends Error {
    constructor(code, message, data) {
        super(`MCP error ${code}: ${message}`);
        this.code = code;
        this.data = data;
        this.name = 'McpError';
    }
    /**
     * Factory method to create the appropriate error type based on the error code and data
     */
    static fromError(code, message, data) {
        // Check for specific error types
        if (code === ErrorCode.UrlElicitationRequired && data) {
            const errorData = data;
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations, message);
            }
        }
        // Default to generic McpError
        return new McpError(code, message, data);
    }
}
exports.McpError = McpError;
/**
 * Specialized error type when a tool requires a URL mode elicitation.
 * This makes it nicer for the client to handle since there is specific data to work with instead of just a code to check against.
 */
class UrlElicitationRequiredError extends McpError {
    constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ErrorCode.UrlElicitationRequired, message, {
            elicitations: elicitations
        });
    }
    get elicitations() {
        var _a, _b;
        return (_b = (_a = this.data) === null || _a === void 0 ? void 0 : _a.elicitations) !== null && _b !== void 0 ? _b : [];
    }
}
exports.UrlElicitationRequiredError = UrlElicitationRequiredError;
//# sourceMappingURL=types.js.map