export const SCHEMA_TO_METHOD: Record<string, string> = {
    InitializeRequestSchema: 'initialize',
    CallToolRequestSchema: 'tools/call',
    ListToolsRequestSchema: 'tools/list',
    ListPromptsRequestSchema: 'prompts/list',
    GetPromptRequestSchema: 'prompts/get',
    ListResourcesRequestSchema: 'resources/list',
    ReadResourceRequestSchema: 'resources/read',
    ListResourceTemplatesRequestSchema: 'resources/templates/list',
    SubscribeRequestSchema: 'resources/subscribe',
    UnsubscribeRequestSchema: 'resources/unsubscribe',
    CreateMessageRequestSchema: 'sampling/createMessage',
    ElicitRequestSchema: 'elicitation/create',
    SetLevelRequestSchema: 'logging/setLevel',
    PingRequestSchema: 'ping',
    CompleteRequestSchema: 'completion/complete',
    ListRootsRequestSchema: 'roots/list'
};

export const NOTIFICATION_SCHEMA_TO_METHOD: Record<string, string> = {
    LoggingMessageNotificationSchema: 'notifications/message',
    ToolListChangedNotificationSchema: 'notifications/tools/list_changed',
    ResourceListChangedNotificationSchema: 'notifications/resources/list_changed',
    PromptListChangedNotificationSchema: 'notifications/prompts/list_changed',
    ResourceUpdatedNotificationSchema: 'notifications/resources/updated',
    ProgressNotificationSchema: 'notifications/progress',
    CancelledNotificationSchema: 'notifications/cancelled',
    InitializedNotificationSchema: 'notifications/initialized',
    RootsListChangedNotificationSchema: 'notifications/roots/list_changed',
    ElicitationCompleteNotificationSchema: 'notifications/elicitation/complete'
};

/**
 * v1 task-handler schema names. The experimental tasks feature was removed in v2
 * (SEP-2663) and the task method strings are excluded from the typed
 * `RequestMethod` / `NotificationMethod` surface, so these are NOT in the rewrite
 * maps above — the handler-registration transform emits a dedicated
 * action-required diagnostic instead.
 */
export const REMOVED_TASK_SCHEMAS: ReadonlySet<string> = new Set([
    'GetTaskRequestSchema',
    'GetTaskPayloadRequestSchema',
    'ListTasksRequestSchema',
    'CancelTaskRequestSchema',
    'CreateTaskRequestSchema',
    'TaskStatusNotificationSchema'
]);
