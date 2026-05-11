import * as z from 'zod/v4';

import { JSONRPC_VERSION, RELATED_TASK_META_KEY } from './constants.js';
import type {
    JSONArray,
    JSONObject,
    JSONValue,
    NotificationMethod,
    NotificationTypeMap,
    RequestMethod,
    RequestTypeMap,
    ResultTypeMap
} from './types.js';

export const JSONValueSchema: z.ZodType<JSONValue, JSONValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), JSONValueSchema), z.array(JSONValueSchema)])
);
export const JSONObjectSchema: z.ZodType<JSONObject, JSONObject> = z.record(z.string(), JSONValueSchema);
export const JSONArraySchema: z.ZodType<JSONArray, JSONArray> = z.array(JSONValueSchema);
/**
 * A progress token, used to associate progress notifications with the original request.
 */
export const ProgressTokenSchema = z.union([z.string(), z.number().int()]);

/**
 * An opaque token used to represent a cursor for pagination.
 */
export const CursorSchema = z.string();

/**
 * Task creation parameters, used to ask that the server create a task to represent a request.
 */
export const TaskCreationParamsSchema = z.looseObject({
    /**
     * Requested duration in milliseconds to retain task from creation.
     */
    ttl: z.number().optional(),

    /**
     * Time in milliseconds to wait between task status requests.
     */
    pollInterval: z.number().optional()
});

export const TaskMetadataSchema = z.object({
    ttl: z.number().optional()
});

/**
 * Metadata for associating messages with a task.
 * Include this in the `_meta` field under the key `io.modelcontextprotocol/related-task`.
 */
export const RelatedTaskMetadataSchema = z.object({
    taskId: z.string()
});

export const RequestMetaSchema = z.looseObject({
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: ProgressTokenSchema.optional(),
    /**
     * If specified, this request is related to the provided task.
     */
    [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
});

/**
 * Common params for any request.
 */
export const BaseRequestParamsSchema = z.object({
    /**
     * See [General fields: `_meta`](/specification/draft/basic/index#meta) for notes on `_meta` usage.
     */
    _meta: RequestMetaSchema.optional()
});

/**
 * Common params for any task-augmented request.
 */
export const TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * If specified, the caller is requesting task-augmented execution for this request.
     * The request will return a `CreateTaskResult` immediately, and the actual result can be
     * retrieved later via `tasks/result`.
     *
     * Task augmentation is subject to capability negotiation - receivers MUST declare support
     * for task augmentation of specific request types in their capabilities.
     */
    task: TaskMetadataSchema.optional()
});

export const RequestSchema = z.object({
    method: z.string(),
    params: BaseRequestParamsSchema.loose().optional()
});

export const NotificationsParamsSchema = z.object({
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: RequestMetaSchema.optional()
});

export const NotificationSchema = z.object({
    method: z.string(),
    params: NotificationsParamsSchema.loose().optional()
});

export const ResultSchema = z.looseObject({
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: RequestMetaSchema.optional()
});

/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
export const RequestIdSchema = z.union([z.string(), z.number().int()]);

/**
 * A request that expects a response.
 */
export const JSONRPCRequestSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        id: RequestIdSchema,
        ...RequestSchema.shape
    })
    .strict();

/**
 * A notification which does not expect a response.
 */
export const JSONRPCNotificationSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        ...NotificationSchema.shape
    })
    .strict();

/**
 * A successful (non-error) response to a request.
 */
export const JSONRPCResultResponseSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        id: RequestIdSchema,
        result: ResultSchema
    })
    .strict();

/**
 * A response to a request that indicates an error occurred.
 */
export const JSONRPCErrorResponseSchema = z
    .object({
        jsonrpc: z.literal(JSONRPC_VERSION),
        id: RequestIdSchema.optional(),
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
            data: z.unknown().optional()
        })
    })
    .strict();

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

export const CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The ID of the request to cancel.
     *
     * This MUST correspond to the ID of a request previously issued in the same direction.
     */
    requestId: RequestIdSchema.optional(),
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
 * A client MUST NOT attempt to cancel its {@linkcode InitializeRequest | initialize} request.
 */
export const CancelledNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/cancelled'),
    params: CancelledNotificationParamsSchema
});

/* Base Metadata */
/**
 * Icon schema for use in {@link Tool | tools}, {@link Prompt | prompts}, {@link Resource | resources}, and {@link Implementation | implementations}.
 */
export const IconSchema = z.object({
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
    sizes: z.array(z.string()).optional(),
    /**
     * Optional specifier for the theme this icon is designed for. `light` indicates
     * the icon is designed to be used with a light background, and `dark` indicates
     * the icon is designed to be used with a dark background.
     *
     * If not provided, the client should assume the icon can be used with any theme.
     */
    theme: z.enum(['light', 'dark']).optional()
});

/**
 * Base schema to add `icons` property.
 *
 */
export const IconsSchema = z.object({
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
    icons: z.array(IconSchema).optional()
});

/**
 * Base metadata interface for common properties across {@link Resource | resources}, {@link Tool | tools}, {@link Prompt | prompts}, and {@link Implementation | implementations}.
 */
export const BaseMetadataSchema = z.object({
    /** Intended for programmatic or logical use, but used as a display name in past specs or fallback */
    name: z.string(),
    /**
     * Intended for UI and end-user contexts — optimized to be human-readable and easily understood,
     * even by those unfamiliar with domain-specific terminology.
     *
     * If not provided, the `name` should be used for display (except for `Tool`,
     * where `annotations.title` should be given precedence over using `name`,
     * if present).
     */
    title: z.string().optional()
});

/* Initialization */
/**
 * Describes the name and version of an MCP implementation.
 */
export const ImplementationSchema = BaseMetadataSchema.extend({
    ...BaseMetadataSchema.shape,
    ...IconsSchema.shape,
    version: z.string(),
    /**
     * An optional URL of the website for this implementation.
     */
    websiteUrl: z.string().optional(),

    /**
     * An optional human-readable description of what this implementation does.
     *
     * This can be used by clients or servers to provide context about their purpose
     * and capabilities. For example, a server might describe the types of resources
     * or tools it provides, while a client might describe its intended use case.
     */
    description: z.string().optional()
});

const FormElicitationCapabilitySchema = z.intersection(
    z.object({
        applyDefaults: z.boolean().optional()
    }),
    JSONObjectSchema
);

const ElicitationCapabilitySchema = z.preprocess(
    value => {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
            return { form: {} };
        }
        return value;
    },
    z.intersection(
        z.object({
            form: FormElicitationCapabilitySchema.optional(),
            url: JSONObjectSchema.optional()
        }),
        JSONObjectSchema.optional()
    )
);

/**
 * Task capabilities for clients, indicating which request types support task creation.
 */
export const ClientTasksCapabilitySchema = z.looseObject({
    /**
     * Present if the client supports listing tasks.
     */
    list: JSONObjectSchema.optional(),
    /**
     * Present if the client supports cancelling tasks.
     */
    cancel: JSONObjectSchema.optional(),
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
                    createMessage: JSONObjectSchema.optional()
                })
                .optional(),
            /**
             * Task support for elicitation requests.
             */
            elicitation: z
                .looseObject({
                    create: JSONObjectSchema.optional()
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
    list: JSONObjectSchema.optional(),
    /**
     * Present if the server supports cancelling tasks.
     */
    cancel: JSONObjectSchema.optional(),
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
                    call: JSONObjectSchema.optional()
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
    experimental: z.record(z.string(), JSONObjectSchema).optional(),
    /**
     * Present if the client supports sampling from an LLM.
     */
    sampling: z
        .object({
            /**
             * Present if the client supports context inclusion via `includeContext` parameter.
             * If not declared, servers SHOULD only use `includeContext: "none"` (or omit it).
             */
            context: JSONObjectSchema.optional(),
            /**
             * Present if the client supports tool use via `tools` and `toolChoice` parameters.
             */
            tools: JSONObjectSchema.optional()
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
    tasks: ClientTasksCapabilitySchema.optional(),
    /**
     * Extensions that the client supports. Keys are extension identifiers (vendor-prefix/extension-name).
     */
    extensions: z.record(z.string(), JSONObjectSchema).optional()
});

export const InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The latest version of the Model Context Protocol that the client supports. The client MAY decide to support older versions as well.
     */
    protocolVersion: z.string(),
    capabilities: ClientCapabilitiesSchema,
    clientInfo: ImplementationSchema
});
/**
 * This request is sent from the client to the server when it first connects, asking it to begin initialization.
 */
export const InitializeRequestSchema = RequestSchema.extend({
    method: z.literal('initialize'),
    params: InitializeRequestParamsSchema
});

/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
export const ServerCapabilitiesSchema = z.object({
    /**
     * Experimental, non-standard capabilities that the server supports.
     */
    experimental: z.record(z.string(), JSONObjectSchema).optional(),
    /**
     * Present if the server supports sending log messages to the client.
     */
    logging: JSONObjectSchema.optional(),
    /**
     * Present if the server supports sending completions to the client.
     */
    completions: JSONObjectSchema.optional(),
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
    tasks: ServerTasksCapabilitySchema.optional(),
    /**
     * Extensions that the server supports. Keys are extension identifiers (vendor-prefix/extension-name).
     */
    extensions: z.record(z.string(), JSONObjectSchema).optional()
});

/**
 * After receiving an initialize request from the client, the server sends this response.
 */
export const InitializeResultSchema = ResultSchema.extend({
    /**
     * The version of the Model Context Protocol that the server wants to use. This may not match the version that the client requested. If the client cannot support this version, it MUST disconnect.
     */
    protocolVersion: z.string(),
    capabilities: ServerCapabilitiesSchema,
    serverInfo: ImplementationSchema,
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
export const InitializedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/initialized'),
    params: NotificationsParamsSchema.optional()
});

/* Ping */
/**
 * A ping, issued by either the server or the client, to check that the other party is still alive. The receiver must promptly respond, or else may be disconnected.
 */
export const PingRequestSchema = RequestSchema.extend({
    method: z.literal('ping'),
    params: BaseRequestParamsSchema.optional()
});

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
/**
 * An out-of-band notification used to inform the receiver of a progress update for a long-running request.
 *
 * @category notifications/progress
 */
export const ProgressNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/progress'),
    params: ProgressNotificationParamsSchema
});

export const PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * An opaque token representing the current pagination position.
     * If provided, the server should return results starting after this cursor.
     */
    cursor: CursorSchema.optional()
});

/* Pagination */
export const PaginatedRequestSchema = RequestSchema.extend({
    params: PaginatedRequestParamsSchema.optional()
});

export const PaginatedResultSchema = ResultSchema.extend({
    /**
     * An opaque token representing the pagination position after the last returned result.
     * If present, there may be more results available.
     */
    nextCursor: CursorSchema.optional()
});

/**
 * The status of a task.
 * */
export const TaskStatusSchema = z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']);

/* Tasks */
/**
 * A pollable state object associated with a request.
 */
export const TaskSchema = z.object({
    taskId: z.string(),
    status: TaskStatusSchema,
    /**
     * Time in milliseconds to keep task results available after completion.
     * If `null`, the task has unlimited lifetime until manually cleaned up.
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
 * Result returned when a task is created, containing the task data wrapped in a `task` field.
 */
export const CreateTaskResultSchema = ResultSchema.extend({
    task: TaskSchema
});

/**
 * Parameters for task status notification.
 */
export const TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);

/**
 * A notification sent when a task's status changes.
 */
export const TaskStatusNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/tasks/status'),
    params: TaskStatusNotificationParamsSchema
});

/**
 * A request to get the state of a specific task.
 */
export const GetTaskRequestSchema = RequestSchema.extend({
    method: z.literal('tasks/get'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});

/**
 * The response to a {@linkcode GetTaskRequest | tasks/get} request.
 */
export const GetTaskResultSchema = ResultSchema.merge(TaskSchema);

/**
 * A request to get the result of a specific task.
 */
export const GetTaskPayloadRequestSchema = RequestSchema.extend({
    method: z.literal('tasks/result'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});

/**
 * The response to a `tasks/result` request.
 * The structure matches the result type of the original request.
 * For example, a {@linkcode CallToolRequest | tools/call} task would return the `CallToolResult` structure.
 *
 */
export const GetTaskPayloadResultSchema = ResultSchema.loose();

/**
 * A request to list tasks.
 */
export const ListTasksRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('tasks/list')
});

/**
 * The response to a {@linkcode ListTasksRequest | tasks/list} request.
 */
export const ListTasksResultSchema = PaginatedResultSchema.extend({
    tasks: z.array(TaskSchema)
});

/**
 * A request to cancel a specific task.
 */
export const CancelTaskRequestSchema = RequestSchema.extend({
    method: z.literal('tasks/cancel'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});

/**
 * The response to a {@linkcode CancelTaskRequest | tasks/cancel} request.
 */
export const CancelTaskResultSchema = ResultSchema.merge(TaskSchema);

/* Resources */
/**
 * The contents of a specific resource or sub-resource.
 */
export const ResourceContentsSchema = z.object({
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
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

export const TextResourceContentsSchema = ResourceContentsSchema.extend({
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
const Base64Schema = z.string().refine(
    val => {
        try {
            // atob throws a DOMException if the string contains characters
            // that are not part of the Base64 character set.
            atob(val);
            return true;
        } catch {
            return false;
        }
    },
    { message: 'Invalid Base64 string' }
);

export const BlobResourceContentsSchema = ResourceContentsSchema.extend({
    /**
     * A base64-encoded string representing the binary data of the item.
     */
    blob: Base64Schema
});

/**
 * The sender or recipient of messages and data in a conversation.
 */
export const RoleSchema = z.enum(['user', 'assistant']);

/**
 * Optional annotations providing clients additional context about a resource.
 */
export const AnnotationsSchema = z.object({
    /**
     * Intended audience(s) for the resource.
     */
    audience: z.array(RoleSchema).optional(),

    /**
     * Importance hint for the resource, from 0 (least) to 1 (most).
     */
    priority: z.number().min(0).max(1).optional(),

    /**
     * ISO 8601 timestamp for the most recent modification.
     */
    lastModified: z.iso.datetime({ offset: true }).optional()
});

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
     * The size of the raw resource content, in bytes (i.e., before base64 encoding or any tokenization), if known.
     *
     * This can be used by Hosts to display file sizes and estimate context window usage.
     */
    size: z.optional(z.number()),

    /**
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
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
     * for notes on `_meta` usage.
     */
    _meta: z.optional(z.looseObject({}))
});

/**
 * Sent from the client to request a list of resources the server has.
 */
export const ListResourcesRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('resources/list')
});

/**
 * The server's response to a {@linkcode ListResourcesRequest | resources/list} request from the client.
 */
export const ListResourcesResultSchema = PaginatedResultSchema.extend({
    resources: z.array(ResourceSchema)
});

/**
 * Sent from the client to request a list of resource templates the server has.
 */
export const ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('resources/templates/list')
});

/**
 * The server's response to a {@linkcode ListResourceTemplatesRequest | resources/templates/list} request from the client.
 */
export const ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({
    resourceTemplates: z.array(ResourceTemplateSchema)
});

export const ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The URI of the resource to read. The URI can use any protocol; it is up to the server how to interpret it.
     *
     * @format uri
     */
    uri: z.string()
});

/**
 * Parameters for a {@linkcode ReadResourceRequest | resources/read} request.
 */
export const ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;

/**
 * Sent from the client to the server, to read a specific resource URI.
 */
export const ReadResourceRequestSchema = RequestSchema.extend({
    method: z.literal('resources/read'),
    params: ReadResourceRequestParamsSchema
});

/**
 * The server's response to a {@linkcode ReadResourceRequest | resources/read} request from the client.
 */
export const ReadResourceResultSchema = ResultSchema.extend({
    contents: z.array(z.union([TextResourceContentsSchema, BlobResourceContentsSchema]))
});

/**
 * An optional notification from the server to the client, informing it that the list of resources it can read from has changed. This may be issued by servers without any previous subscription from the client.
 */
export const ResourceListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/resources/list_changed'),
    params: NotificationsParamsSchema.optional()
});

export const SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
/**
 * Sent from the client to request `resources/updated` notifications from the server whenever a particular resource changes.
 */
export const SubscribeRequestSchema = RequestSchema.extend({
    method: z.literal('resources/subscribe'),
    params: SubscribeRequestParamsSchema
});

export const UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;
/**
 * Sent from the client to request cancellation of {@linkcode ResourceUpdatedNotification | resources/updated} notifications from the server. This should follow a previous {@linkcode SubscribeRequest | resources/subscribe} request.
 */
export const UnsubscribeRequestSchema = RequestSchema.extend({
    method: z.literal('resources/unsubscribe'),
    params: UnsubscribeRequestParamsSchema
});

/**
 * Parameters for a {@linkcode ResourceUpdatedNotification | notifications/resources/updated} notification.
 */
export const ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({
    /**
     * The URI of the resource that has been updated. This might be a sub-resource of the one that the client actually subscribed to.
     */
    uri: z.string()
});

/**
 * A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a {@linkcode SubscribeRequest | resources/subscribe} request.
 */
export const ResourceUpdatedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/resources/updated'),
    params: ResourceUpdatedNotificationParamsSchema
});

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
     * for notes on `_meta` usage.
     */
    _meta: z.optional(z.looseObject({}))
});

/**
 * Sent from the client to request a list of prompts and prompt templates the server has.
 */
export const ListPromptsRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('prompts/list')
});

/**
 * The server's response to a {@linkcode ListPromptsRequest | prompts/list} request from the client.
 */
export const ListPromptsResultSchema = PaginatedResultSchema.extend({
    prompts: z.array(PromptSchema)
});

/**
 * Parameters for a {@linkcode GetPromptRequest | prompts/get} request.
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
/**
 * Used by the client to get a prompt provided by the server.
 */
export const GetPromptRequestSchema = RequestSchema.extend({
    method: z.literal('prompts/get'),
    params: GetPromptRequestParamsSchema
});

/**
 * Text provided to or from an LLM.
 */
export const TextContentSchema = z.object({
    type: z.literal('text'),
    /**
     * The text content of the message.
     */
    text: z.string(),

    /**
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * An image provided to or from an LLM.
 */
export const ImageContentSchema = z.object({
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
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * Audio content provided to or from an LLM.
 */
export const AudioContentSchema = z.object({
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
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

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
     * Used to correlate with `ToolResultContent` in subsequent messages.
     */
    id: z.string(),
    /**
     * Arguments to pass to the tool.
     * Must conform to the tool's `inputSchema`.
     */
    input: z.record(z.string(), z.unknown()),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * The contents of a resource, embedded into a prompt or tool call result.
 */
export const EmbeddedResourceSchema = z.object({
    type: z.literal('resource'),
    resource: z.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
    /**
     * Optional annotations for the client.
     */
    annotations: AnnotationsSchema.optional(),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * A resource that the server is capable of reading, included in a prompt or tool call result.
 *
 * Note: resource links returned by tools are not guaranteed to appear in the results of {@linkcode ListResourcesRequest | resources/list} requests.
 */
export const ResourceLinkSchema = ResourceSchema.extend({
    type: z.literal('resource_link')
});

/**
 * A content block that can be used in prompts and tool results.
 */
export const ContentBlockSchema = z.union([
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ResourceLinkSchema,
    EmbeddedResourceSchema
]);

/**
 * Describes a message returned as part of a prompt.
 */
export const PromptMessageSchema = z.object({
    role: RoleSchema,
    content: ContentBlockSchema
});

/**
 * The server's response to a {@linkcode GetPromptRequest | prompts/get} request from the client.
 */
export const GetPromptResultSchema = ResultSchema.extend({
    /**
     * An optional description for the prompt.
     */
    description: z.string().optional(),
    messages: z.array(PromptMessageSchema)
});

/**
 * An optional notification from the server to the client, informing it that the list of prompts it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
export const PromptListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/prompts/list_changed'),
    params: NotificationsParamsSchema.optional()
});

/* Tools */
/**
 * Additional properties describing a `Tool` to clients.
 *
 * NOTE: all properties in {@linkcode ToolAnnotations} are **hints**.
 * They are not guaranteed to provide a faithful description of
 * tool behavior (including descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on `ToolAnnotations`
 * received from untrusted servers.
 */
export const ToolAnnotationsSchema = z.object({
    /**
     * A human-readable title for the tool.
     */
    title: z.string().optional(),

    /**
     * If `true`, the tool does not modify its environment.
     *
     * Default: `false`
     */
    readOnlyHint: z.boolean().optional(),

    /**
     * If `true`, the tool may perform destructive updates to its environment.
     * If `false`, the tool performs only additive updates.
     *
     * (This property is meaningful only when `readOnlyHint == false`)
     *
     * Default: `true`
     */
    destructiveHint: z.boolean().optional(),

    /**
     * If `true`, calling the tool repeatedly with the same arguments
     * will have no additional effect on its environment.
     *
     * (This property is meaningful only when `readOnlyHint == false`)
     *
     * Default: `false`
     */
    idempotentHint: z.boolean().optional(),

    /**
     * If `true`, this tool may interact with an "open world" of external
     * entities. If `false`, the tool's domain of interaction is closed.
     * For example, the world of a web search tool is open, whereas that
     * of a memory tool is not.
     *
     * Default: `true`
     */
    openWorldHint: z.boolean().optional()
});

/**
 * Execution-related properties for a tool.
 */
export const ToolExecutionSchema = z.object({
    /**
     * Indicates the tool's preference for task-augmented execution.
     * - `"required"`: Clients MUST invoke the tool as a task
     * - `"optional"`: Clients MAY invoke the tool as a task or normal request
     * - `"forbidden"`: Clients MUST NOT attempt to invoke the tool as a task
     *
     * If not present, defaults to `"forbidden"`.
     */
    taskSupport: z.enum(['required', 'optional', 'forbidden']).optional()
});

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
     * Must have `type: 'object'` at the root level per MCP spec.
     */
    inputSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), JSONValueSchema).optional(),
            required: z.array(z.string()).optional()
        })
        .catchall(z.unknown()),
    /**
     * An optional JSON Schema 2020-12 object defining the structure of the tool's output
     * returned in the `structuredContent` field of a `CallToolResult`.
     * Must have `type: 'object'` at the root level per MCP spec.
     */
    outputSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), JSONValueSchema).optional(),
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
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * Sent from the client to request a list of tools the server has.
 */
export const ListToolsRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('tools/list')
});

/**
 * The server's response to a {@linkcode ListToolsRequest | tools/list} request from the client.
 */
export const ListToolsResultSchema = PaginatedResultSchema.extend({
    tools: z.array(ToolSchema)
});

/**
 * The server's response to a tool call.
 */
export const CallToolResultSchema = ResultSchema.extend({
    /**
     * A list of content objects that represent the result of the tool call.
     *
     * If the `Tool` does not define an outputSchema, this field MUST be present in the result.
     * For backwards compatibility, this field is always present, but it may be empty.
     */
    content: z.array(ContentBlockSchema).default([]),

    /**
     * An object containing structured tool output.
     *
     * If the `Tool` defines an outputSchema, this field MUST be present in the result, and contain a JSON object that matches the schema.
     */
    structuredContent: z.record(z.string(), z.unknown()).optional(),

    /**
     * Whether the tool call ended in an error.
     *
     * If not set, this is assumed to be `false` (the call was successful).
     *
     * Any errors that originate from the tool SHOULD be reported inside the result
     * object, with `isError` set to `true`, _not_ as an MCP protocol-level error
     * response. Otherwise, the LLM would not be able to see that an error occurred
     * and self-correct.
     *
     * However, any errors in _finding_ the tool, an error indicating that the
     * server does not support tool calls, or any other exceptional conditions,
     * should be reported as an MCP error response.
     */
    isError: z.boolean().optional()
});

/**
 * {@linkcode CallToolResultSchema} extended with backwards compatibility to protocol version 2024-10-07.
 */
export const CompatibilityCallToolResultSchema = CallToolResultSchema.or(
    ResultSchema.extend({
        toolResult: z.unknown()
    })
);

/**
 * Parameters for a `tools/call` request.
 */
export const CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
    /**
     * The name of the tool to call.
     */
    name: z.string(),
    /**
     * Arguments to pass to the tool.
     */
    arguments: z.record(z.string(), z.unknown()).optional()
});

/**
 * Used by the client to invoke a tool provided by the server.
 */
export const CallToolRequestSchema = RequestSchema.extend({
    method: z.literal('tools/call'),
    params: CallToolRequestParamsSchema
});

/**
 * An optional notification from the server to the client, informing it that the list of tools it offers has changed. This may be issued by servers without any previous subscription from the client.
 */
export const ToolListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/tools/list_changed'),
    params: NotificationsParamsSchema.optional()
});

/**
 * Base schema for list changed subscription options (without callback).
 * Used internally for Zod validation of `autoRefresh` and `debounceMs`.
 */
export const ListChangedOptionsBaseSchema = z.object({
    /**
     * If `true`, the list will be refreshed automatically when a list changed notification is received.
     * The callback will be called with the updated list.
     *
     * If `false`, the callback will be called with `null` items, allowing manual refresh.
     *
     * @default true
     */
    autoRefresh: z.boolean().default(true),
    /**
     * Debounce time in milliseconds for list changed notification processing.
     *
     * Multiple notifications received within this timeframe will only trigger one refresh.
     * Set to `0` to disable debouncing.
     *
     * @default 300
     */
    debounceMs: z.number().int().nonnegative().default(300)
});

/* Logging */
/**
 * The severity of a log message.
 */
export const LoggingLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);

/**
 * Parameters for a `logging/setLevel` request.
 */
export const SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({
    /**
     * The level of logging that the client wants to receive from the server. The server should send all logs at this level and higher (i.e., more severe) to the client as `notifications/logging/message`.
     */
    level: LoggingLevelSchema
});
/**
 * A request from the client to the server, to enable or adjust logging.
 */
export const SetLevelRequestSchema = RequestSchema.extend({
    method: z.literal('logging/setLevel'),
    params: SetLevelRequestParamsSchema
});

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
/**
 * Notification of a log message passed from server to client. If no `logging/setLevel` request has been sent from the client, the server MAY decide which messages to send automatically.
 */
export const LoggingMessageNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/message'),
    params: LoggingMessageNotificationParamsSchema
});

/* Sampling */
/**
 * Hints to use for model selection.
 */
export const ModelHintSchema = z.object({
    /**
     * A hint for a model name.
     */
    name: z.string().optional()
});

/**
 * The server's preferences for model selection, requested of the client during sampling.
 */
export const ModelPreferencesSchema = z.object({
    /**
     * Optional hints to use for model selection.
     */
    hints: z.array(ModelHintSchema).optional(),
    /**
     * How much to prioritize cost when selecting a model.
     */
    costPriority: z.number().min(0).max(1).optional(),
    /**
     * How much to prioritize sampling speed (latency) when selecting a model.
     */
    speedPriority: z.number().min(0).max(1).optional(),
    /**
     * How much to prioritize intelligence and capabilities when selecting a model.
     */
    intelligencePriority: z.number().min(0).max(1).optional()
});

/**
 * Controls tool usage behavior in sampling requests.
 */
export const ToolChoiceSchema = z.object({
    /**
     * Controls when tools are used:
     * - `"auto"`: Model decides whether to use tools (default)
     * - `"required"`: Model MUST use at least one tool before completing
     * - `"none"`: Model MUST NOT use any tools
     */
    mode: z.enum(['auto', 'required', 'none']).optional()
});

/**
 * The result of a tool execution, provided by the user (server).
 * Represents the outcome of invoking a tool requested via `ToolUseContent`.
 */
export const ToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string().describe('The unique identifier for the corresponding tool call.'),
    content: z.array(ContentBlockSchema).default([]),
    structuredContent: z.object({}).loose().optional(),
    isError: z.boolean().optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * Basic content types for sampling responses (without tool use).
 * Used for backwards-compatible {@linkcode CreateMessageResult} when tools are not used.
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

/**
 * Describes a message issued to or received from an LLM API.
 */
export const SamplingMessageSchema = z.object({
    role: RoleSchema,
    content: z.union([SamplingMessageContentBlockSchema, z.array(SamplingMessageContentBlockSchema)]),
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * Parameters for a `sampling/createMessage` request.
 */
export const CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
    messages: z.array(SamplingMessageSchema),
    /**
     * The server's preferences for which model to select. The client MAY modify or omit this request.
     */
    modelPreferences: ModelPreferencesSchema.optional(),
    /**
     * An optional system prompt the server wants to use for sampling. The client MAY modify or omit this prompt.
     */
    systemPrompt: z.string().optional(),
    /**
     * A request to include context from one or more MCP servers (including the caller), to be attached to the prompt.
     * The client MAY ignore this request.
     *
     * Default is `"none"`. Values `"thisServer"` and `"allServers"` are soft-deprecated. Servers SHOULD only use these values if the client
     * declares `ClientCapabilities`.`sampling.context`. These values may be removed in future spec releases.
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
    metadata: JSONObjectSchema.optional(),
    /**
     * Tools that the model may use during generation.
     * The client MUST return an error if this field is provided but `ClientCapabilities`.`sampling.tools` is not declared.
     */
    tools: z.array(ToolSchema).optional(),
    /**
     * Controls how the model uses tools.
     * The client MUST return an error if this field is provided but `ClientCapabilities`.`sampling.tools` is not declared.
     * Default is `{ mode: "auto" }`.
     */
    toolChoice: ToolChoiceSchema.optional()
});
/**
 * A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
 */
export const CreateMessageRequestSchema = RequestSchema.extend({
    method: z.literal('sampling/createMessage'),
    params: CreateMessageRequestParamsSchema
});

/**
 * The client's response to a `sampling/create_message` request from the server.
 * This is the backwards-compatible version that returns single content (no arrays).
 * Used when the request does not include tools.
 */
export const CreateMessageResultSchema = ResultSchema.extend({
    /**
     * The name of the model that generated the message.
     */
    model: z.string(),
    /**
     * The reason why sampling stopped, if known.
     *
     * Standard values:
     * - `"endTurn"`: Natural end of the assistant's turn
     * - `"stopSequence"`: A stop sequence was encountered
     * - `"maxTokens"`: Maximum token limit was reached
     *
     * This field is an open string to allow for provider-specific stop reasons.
     */
    stopReason: z.optional(z.enum(['endTurn', 'stopSequence', 'maxTokens']).or(z.string())),
    role: RoleSchema,
    /**
     * Response content. Single content block (text, image, or audio).
     */
    content: SamplingContentSchema
});

/**
 * The client's response to a `sampling/create_message` request when tools were provided.
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
     * - `"endTurn"`: Natural end of the assistant's turn
     * - `"stopSequence"`: A stop sequence was encountered
     * - `"maxTokens"`: Maximum token limit was reached
     * - `"toolUse"`: The model wants to use one or more tools
     *
     * This field is an open string to allow for provider-specific stop reasons.
     */
    stopReason: z.optional(z.enum(['endTurn', 'stopSequence', 'maxTokens', 'toolUse']).or(z.string())),
    role: RoleSchema,
    /**
     * Response content. May be a single block or array. May include `ToolUseContent` if `stopReason` is `"toolUse"`.
     */
    content: z.union([SamplingMessageContentBlockSchema, z.array(SamplingMessageContentBlockSchema)])
});

/* Elicitation */
/**
 * Primitive schema definition for boolean fields.
 */
export const BooleanSchemaSchema = z.object({
    type: z.literal('boolean'),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional()
});

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

/**
 * Primitive schema definition for number fields.
 */
export const NumberSchemaSchema = z.object({
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
export const UntitledSingleSelectEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()),
    default: z.string().optional()
});

/**
 * Schema for single-selection enumeration with display titles for each option.
 */
export const TitledSingleSelectEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(
        z.object({
            const: z.string(),
            title: z.string()
        })
    ),
    default: z.string().optional()
});

/**
 * Use {@linkcode TitledSingleSelectEnumSchema} instead.
 * This interface will be removed in a future version.
 */
export const LegacyTitledEnumSchemaSchema = z.object({
    type: z.literal('string'),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()),
    enumNames: z.array(z.string()).optional(),
    default: z.string().optional()
});

// Combined single selection enumeration
export const SingleSelectEnumSchemaSchema = z.union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);

/**
 * Schema for multiple-selection enumeration without display titles for options.
 */
export const UntitledMultiSelectEnumSchemaSchema = z.object({
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
export const TitledMultiSelectEnumSchemaSchema = z.object({
    type: z.literal('array'),
    title: z.string().optional(),
    description: z.string().optional(),
    minItems: z.number().optional(),
    maxItems: z.number().optional(),
    items: z.object({
        anyOf: z.array(
            z.object({
                const: z.string(),
                title: z.string()
            })
        )
    }),
    default: z.array(z.string()).optional()
});

/**
 * Combined schema for multiple-selection enumeration
 */
export const MultiSelectEnumSchemaSchema = z.union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);

/**
 * Primitive schema definition for enum fields.
 */
export const EnumSchemaSchema = z.union([LegacyTitledEnumSchemaSchema, SingleSelectEnumSchemaSchema, MultiSelectEnumSchemaSchema]);

/**
 * Union of all primitive schema definitions.
 */
export const PrimitiveSchemaDefinitionSchema = z.union([EnumSchemaSchema, BooleanSchemaSchema, StringSchemaSchema, NumberSchemaSchema]);

/**
 * Parameters for an `elicitation/create` request for form-based elicitation.
 */
export const ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
    /**
     * The elicitation mode.
     *
     * Optional for backward compatibility. Clients MUST treat missing `mode` as `"form"`.
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
    requestedSchema: z
        .object({
            type: z.literal('object'),
            properties: z.record(z.string(), PrimitiveSchemaDefinitionSchema),
            required: z.array(z.string()).optional()
        })
        .catchall(z.unknown())
});

/**
 * Parameters for an {@linkcode ElicitRequest | elicitation/create} request for URL-based elicitation.
 */
export const ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({
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
export const ElicitRequestParamsSchema = z.union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);

/**
 * A request from the server to elicit user input via the client.
 * The client should present the message and form fields to the user (form mode)
 * or navigate to a URL (URL mode).
 */
export const ElicitRequestSchema = RequestSchema.extend({
    method: z.literal('elicitation/create'),
    params: ElicitRequestParamsSchema
});

/**
 * Parameters for a {@linkcode ElicitationCompleteNotification | notifications/elicitation/complete} notification.
 *
 * @category notifications/elicitation/complete
 */
export const ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({
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
export const ElicitationCompleteNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/elicitation/complete'),
    params: ElicitationCompleteNotificationParamsSchema
});

/**
 * The client's response to an {@linkcode ElicitRequest | elicitation/create} request from the server.
 */
export const ElicitResultSchema = ResultSchema.extend({
    /**
     * The user action in response to the elicitation.
     * - `"accept"`: User submitted the form/confirmed the action
     * - `"decline"`: User explicitly declined the action
     * - `"cancel"`: User dismissed without making an explicit choice
     */
    action: z.enum(['accept', 'decline', 'cancel']),
    /**
     * The submitted form data, only present when action is `"accept"`.
     * Contains values matching the requested schema.
     * Per MCP spec, content is "typically omitted" for decline/cancel actions.
     * We normalize `null` to `undefined` for leniency while maintaining type compatibility.
     */
    content: z.preprocess(
        val => (val === null ? undefined : val),
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
    )
});

/* Autocomplete */
/**
 * A reference to a resource or resource template definition.
 */
export const ResourceTemplateReferenceSchema = z.object({
    type: z.literal('ref/resource'),
    /**
     * The URI or URI template of the resource.
     */
    uri: z.string()
});

/**
 * Identifies a prompt.
 */
export const PromptReferenceSchema = z.object({
    type: z.literal('ref/prompt'),
    /**
     * The name of the prompt or prompt template
     */
    name: z.string()
});

/**
 * Parameters for a {@linkcode CompleteRequest | completion/complete} request.
 */
export const CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
    ref: z.union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
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
export const CompleteRequestSchema = RequestSchema.extend({
    method: z.literal('completion/complete'),
    params: CompleteRequestParamsSchema
});

/**
 * The server's response to a {@linkcode CompleteRequest | completion/complete} request
 */
export const CompleteResultSchema = ResultSchema.extend({
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
export const RootSchema = z.object({
    /**
     * The URI identifying the root. This *must* start with `file://` for now.
     */
    uri: z.string().startsWith('file://'),
    /**
     * An optional name for the root.
     */
    name: z.string().optional(),

    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * Sent from the server to request a list of root URIs from the client.
 */
export const ListRootsRequestSchema = RequestSchema.extend({
    method: z.literal('roots/list'),
    params: BaseRequestParamsSchema.optional()
});

/**
 * The client's response to a `roots/list` request from the server.
 */
export const ListRootsResultSchema = ResultSchema.extend({
    roots: z.array(RootSchema)
});

/**
 * A notification from the client to the server, informing it that the list of roots has changed.
 */
export const RootsListChangedNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/roots/list_changed'),
    params: NotificationsParamsSchema.optional()
});

/* Client messages */
export const ClientRequestSchema = z.union([
    PingRequestSchema,
    InitializeRequestSchema,
    CompleteRequestSchema,
    SetLevelRequestSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    CallToolRequestSchema,
    ListToolsRequestSchema,
    GetTaskRequestSchema,
    GetTaskPayloadRequestSchema,
    ListTasksRequestSchema,
    CancelTaskRequestSchema
]);

export const ClientNotificationSchema = z.union([
    CancelledNotificationSchema,
    ProgressNotificationSchema,
    InitializedNotificationSchema,
    RootsListChangedNotificationSchema,
    TaskStatusNotificationSchema
]);

export const ClientResultSchema = z.union([
    EmptyResultSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitResultSchema,
    ListRootsResultSchema,
    GetTaskResultSchema,
    ListTasksResultSchema,
    CreateTaskResultSchema
]);

/* Server messages */
export const ServerRequestSchema = z.union([
    PingRequestSchema,
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ListRootsRequestSchema,
    GetTaskRequestSchema,
    GetTaskPayloadRequestSchema,
    ListTasksRequestSchema,
    CancelTaskRequestSchema
]);

export const ServerNotificationSchema = z.union([
    CancelledNotificationSchema,
    ProgressNotificationSchema,
    LoggingMessageNotificationSchema,
    ResourceUpdatedNotificationSchema,
    ResourceListChangedNotificationSchema,
    ToolListChangedNotificationSchema,
    PromptListChangedNotificationSchema,
    TaskStatusNotificationSchema,
    ElicitationCompleteNotificationSchema
]);

export const ServerResultSchema = z.union([
    EmptyResultSchema,
    InitializeResultSchema,
    CompleteResultSchema,
    GetPromptResultSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    ReadResourceResultSchema,
    CallToolResultSchema,
    ListToolsResultSchema,
    GetTaskResultSchema,
    ListTasksResultSchema,
    CreateTaskResultSchema
]);

/* Runtime schema lookup — result schemas by method */
const resultSchemas: Record<string, z.core.$ZodType> = {
    ping: EmptyResultSchema,
    initialize: InitializeResultSchema,
    'completion/complete': CompleteResultSchema,
    'logging/setLevel': EmptyResultSchema,
    'prompts/get': GetPromptResultSchema,
    'prompts/list': ListPromptsResultSchema,
    'resources/list': ListResourcesResultSchema,
    'resources/templates/list': ListResourceTemplatesResultSchema,
    'resources/read': ReadResourceResultSchema,
    'resources/subscribe': EmptyResultSchema,
    'resources/unsubscribe': EmptyResultSchema,
    'tools/call': z.union([CallToolResultSchema, CreateTaskResultSchema]),
    'tools/list': ListToolsResultSchema,
    'sampling/createMessage': z.union([CreateMessageResultWithToolsSchema, CreateTaskResultSchema]),
    'elicitation/create': z.union([ElicitResultSchema, CreateTaskResultSchema]),
    'roots/list': ListRootsResultSchema,
    'tasks/get': GetTaskResultSchema,
    'tasks/result': ResultSchema,
    'tasks/list': ListTasksResultSchema,
    'tasks/cancel': CancelTaskResultSchema
};

/**
 * Gets the Zod schema for validating results of a given request method.
 * Returns `undefined` for non-spec methods.
 * @see getRequestSchema for explanation of the internal type assertion.
 */
export function getResultSchema<M extends RequestMethod>(method: M): z.ZodType<ResultTypeMap[M]>;
export function getResultSchema(method: string): z.ZodType | undefined;
export function getResultSchema(method: string): z.ZodType | undefined {
    return resultSchemas[method as RequestMethod] as unknown as z.ZodType | undefined;
}

/* Runtime schema lookup — request schemas by method */
type RequestSchemaType = (typeof ClientRequestSchema.options)[number] | (typeof ServerRequestSchema.options)[number];
type NotificationSchemaType = (typeof ClientNotificationSchema.options)[number] | (typeof ServerNotificationSchema.options)[number];

function buildSchemaMap<T extends { shape: { method: { value: string } } }>(schemas: readonly T[]): Record<string, T> {
    const map: Record<string, T> = {};
    for (const schema of schemas) {
        const method = schema.shape.method.value;
        map[method] = schema;
    }
    return map;
}

const requestSchemas = buildSchemaMap([...ClientRequestSchema.options, ...ServerRequestSchema.options] as const) as Record<
    RequestMethod,
    RequestSchemaType
>;
const notificationSchemas = buildSchemaMap([...ClientNotificationSchema.options, ...ServerNotificationSchema.options] as const) as Record<
    NotificationMethod,
    NotificationSchemaType
>;

/**
 * Gets the Zod schema for a given request method.
 * Returns `undefined` for non-spec methods.
 * The return type is a ZodType that parses to RequestTypeMap[M], allowing callers
 * to use schema.parse() without needing additional type assertions.
 *
 * Note: The internal cast is necessary because TypeScript can't correlate the
 * Record-based schema lookup with the MethodToTypeMap-based RequestTypeMap
 * when M is a generic type parameter. Both compute to the same type at
 * instantiation, but TypeScript can't prove this statically.
 */
export function getRequestSchema<M extends RequestMethod>(method: M): z.ZodType<RequestTypeMap[M]>;
export function getRequestSchema(method: string): z.ZodType | undefined;
export function getRequestSchema(method: string): z.ZodType | undefined {
    return requestSchemas[method as RequestMethod] as unknown as z.ZodType | undefined;
}

/**
 * Gets the Zod schema for a given notification method.
 * Returns `undefined` for non-spec methods.
 * @see getRequestSchema for explanation of the internal type assertion.
 */
export function getNotificationSchema<M extends NotificationMethod>(method: M): z.ZodType<NotificationTypeMap[M]>;
export function getNotificationSchema(method: string): z.ZodType | undefined;
export function getNotificationSchema(method: string): z.ZodType | undefined {
    return notificationSchemas[method as NotificationMethod] as unknown as z.ZodType | undefined;
}
