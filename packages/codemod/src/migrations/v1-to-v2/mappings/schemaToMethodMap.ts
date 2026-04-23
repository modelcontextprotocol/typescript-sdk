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
    CompleteRequestSchema: 'completion/complete'
};

export const NOTIFICATION_SCHEMA_TO_METHOD: Record<string, string> = {
    LoggingMessageNotificationSchema: 'notifications/message',
    ToolListChangedNotificationSchema: 'notifications/tools/list_changed',
    ResourceListChangedNotificationSchema: 'notifications/resources/list_changed',
    PromptListChangedNotificationSchema: 'notifications/prompts/list_changed',
    ResourceUpdatedNotificationSchema: 'notifications/resources/updated',
    ProgressNotificationSchema: 'notifications/progress',
    CancelledNotificationSchema: 'notifications/cancelled',
    InitializedNotificationSchema: 'notifications/initialized'
};
