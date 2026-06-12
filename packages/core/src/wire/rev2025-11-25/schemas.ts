/**
 * 2025-era wire schemas: the task family (protocol revision 2025-11-25) and
 * the era's full wire role unions.
 *
 * Everything here is 2025-only WIRE vocabulary, physically absent from the
 * neutral model layer and from the 2026-era codec (Q1 increment 2 - deletions
 * are physical). The task message surface was restored types-only by #2248
 * for interop with task-capable 2025 peers and is parsed ONLY through this
 * era's registry; the deprecated Task* TYPES remain importable from the types
 * barrel (Q1-SD2: nameability is constant, runtime availability is
 * version-keyed) but appear in no API signature.
 *
 * Shared-tier adjudications (documented deviations from a full relocation;
 * each would otherwise change frozen 2025 parse behavior, Q10-L2):
 * - `RelatedTaskMetadataSchema` stays in the neutral `RequestMetaSchema`:
 *   `io.modelcontextprotocol/related-task` is NORMATIVE 2025-11-25 `_meta`
 *   vocabulary, not a leak, and the wire-only lift deliberately exempts it.
 * - `TaskMetadataSchema`/`TaskAugmentedRequestParamsSchema` stay neutral:
 *   they are the (deprecated) `task` param member composed into the shared
 *   request-param schemas; removing the declared key would change strip-mode
 *   parsing for 2025 peers.
 * - The `tasks` capability sub-schemas stay on the shared capability
 *   schemas for the same reason; the 2026-era codec strips `capabilities.tasks`
 *   on encode instead (Q1-SD3 iii).
 */
import * as z from 'zod/v4';

import {
    BaseRequestParamsSchema,
    CallToolRequestSchema,
    CallToolResultSchema,
    CancelledNotificationSchema,
    ClientNotificationSchema as NeutralClientNotificationSchema,
    ClientRequestSchema as NeutralClientRequestSchema,
    ClientResultSchema as NeutralClientResultSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    CreateMessageRequestSchema,
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    ElicitationCompleteNotificationSchema,
    ElicitRequestSchema,
    ElicitResultSchema,
    EmptyResultSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    InitializedNotificationSchema,
    InitializeRequestSchema,
    InitializeResultSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListRootsResultSchema,
    ListToolsRequestSchema,
    ListToolsResultSchema,
    LoggingMessageNotificationSchema,
    NotificationSchema,
    NotificationsParamsSchema,
    PaginatedRequestSchema,
    PaginatedResultSchema,
    PingRequestSchema,
    ProgressNotificationSchema,
    PromptListChangedNotificationSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    RequestSchema,
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
    ResultSchema,
    RootsListChangedNotificationSchema,
    SetLevelRequestSchema,
    SubscribeRequestSchema,
    ToolListChangedNotificationSchema,
    UnsubscribeRequestSchema
} from '../../types/schemas.js';

/**
 * Task creation parameters, used to ask that the server create a task to represent a request.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
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

/**
 * The status of a task.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const TaskStatusSchema = z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']);

/* Tasks */
/**
 * A pollable state object associated with a request.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
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
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const CreateTaskResultSchema = ResultSchema.extend({
    task: TaskSchema
});

/**
 * Parameters for task status notification.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);

/**
 * A notification sent when a task's status changes.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const TaskStatusNotificationSchema = NotificationSchema.extend({
    method: z.literal('notifications/tasks/status'),
    params: TaskStatusNotificationParamsSchema
});

/**
 * A request to get the state of a specific task.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const GetTaskRequestSchema = RequestSchema.extend({
    method: z.literal('tasks/get'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});

/**
 * The response to a {@linkcode GetTaskRequest | tasks/get} request.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const GetTaskResultSchema = ResultSchema.merge(TaskSchema);

/**
 * A request to get the result of a specific task.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
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
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const GetTaskPayloadResultSchema = ResultSchema.loose();

/**
 * A request to list tasks.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const ListTasksRequestSchema = PaginatedRequestSchema.extend({
    method: z.literal('tasks/list')
});

/**
 * The response to a {@linkcode ListTasksRequest | tasks/list} request.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const ListTasksResultSchema = PaginatedResultSchema.extend({
    tasks: z.array(TaskSchema)
});

/**
 * A request to cancel a specific task.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const CancelTaskRequestSchema = RequestSchema.extend({
    method: z.literal('tasks/cancel'),
    params: BaseRequestParamsSchema.extend({
        taskId: z.string()
    })
});

/**
 * The response to a {@linkcode CancelTaskRequest | tasks/cancel} request.
 *
 * @deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only.
 */
export const CancelTaskResultSchema = ResultSchema.merge(TaskSchema);

/* The 2025-era wire role unions: the neutral message sets PLUS the task
 * vocabulary. These are the era-faithful aggregates (what a 2025-11-25 peer
 * may legally put on the wire, per role) and the source the era registry is
 * built from. Member order preserves the pre-split unions (task members
 * last for requests/results; notification members are method-discriminated,
 * so ordering is not observable). */
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

// Reference the imported neutral aggregates so the relationship is explicit
// for readers and tooling: the wire unions above are strict supersets.
void NeutralClientRequestSchema;
void NeutralClientNotificationSchema;
void NeutralClientResultSchema;
