/**
 * This file re-exports Zod schemas generated from spec.types.ts with PascalCase naming
 * for backwards compatibility with the existing types.ts API.
 *
 * The schemas are generated using ts-to-zod from the MCP specification types.
 * Run `npm run generate:schemas` to regenerate.
 *
 * Note: Some schemas in types.ts have additional refinements (e.g., Base64 validation)
 * that are not captured in the generated schemas. Those are kept in types.ts.
 */

// Re-export all generated schemas with PascalCase aliases for backwards compatibility
export {
    // JSON-RPC base types
    progressTokenSchema as ProgressTokenSchema,
    cursorSchema as CursorSchema,
    requestSchema as RequestSchema,
    notificationSchema as NotificationSchema,
    resultSchema as ResultSchema,
    errorSchema as ErrorSchema,
    requestIdSchema as RequestIdSchema,

    // JSON-RPC messages
    jsonrpcRequestSchema as JSONRPCRequestSchema,
    jsonrpcNotificationSchema as JSONRPCNotificationSchema,
    jsonrpcResponseSchema as JSONRPCResponseSchema,
    jsonrpcErrorSchema as JSONRPCErrorSchema,
    jsonrpcMessageSchema as JSONRPCMessageSchema,

    // Empty result
    emptyResultSchema as EmptyResultSchema,

    // Cancellation
    cancelledNotificationParamsSchema as CancelledNotificationParamsSchema,
    cancelledNotificationSchema as CancelledNotificationSchema,

    // Base metadata
    iconSchema as IconSchema,
    iconsSchema as IconsSchema,
    baseMetadataSchema as BaseMetadataSchema,

    // Initialization
    implementationSchema as ImplementationSchema,
    clientCapabilitiesSchema as ClientCapabilitiesSchema,
    initializeRequestParamsSchema as InitializeRequestParamsSchema,
    initializeRequestSchema as InitializeRequestSchema,
    serverCapabilitiesSchema as ServerCapabilitiesSchema,
    initializeResultSchema as InitializeResultSchema,
    initializedNotificationSchema as InitializedNotificationSchema,

    // Ping
    pingRequestSchema as PingRequestSchema,

    // Progress
    progressNotificationParamsSchema as ProgressNotificationParamsSchema,
    progressNotificationSchema as ProgressNotificationSchema,

    // Pagination
    paginatedRequestParamsSchema as PaginatedRequestParamsSchema,
    paginatedRequestSchema as PaginatedRequestSchema,
    paginatedResultSchema as PaginatedResultSchema,

    // Resources
    resourceContentsSchema as ResourceContentsSchema,
    textResourceContentsSchema as TextResourceContentsSchema,
    blobResourceContentsSchema as BlobResourceContentsSchema,
    resourceSchema as ResourceSchema,
    resourceTemplateSchema as ResourceTemplateSchema,
    listResourcesRequestSchema as ListResourcesRequestSchema,
    listResourcesResultSchema as ListResourcesResultSchema,
    listResourceTemplatesRequestSchema as ListResourceTemplatesRequestSchema,
    listResourceTemplatesResultSchema as ListResourceTemplatesResultSchema,
    resourceRequestParamsSchema as ResourceRequestParamsSchema,
    readResourceRequestParamsSchema as ReadResourceRequestParamsSchema,
    readResourceRequestSchema as ReadResourceRequestSchema,
    readResourceResultSchema as ReadResourceResultSchema,
    resourceListChangedNotificationSchema as ResourceListChangedNotificationSchema,
    subscribeRequestParamsSchema as SubscribeRequestParamsSchema,
    subscribeRequestSchema as SubscribeRequestSchema,
    unsubscribeRequestParamsSchema as UnsubscribeRequestParamsSchema,
    unsubscribeRequestSchema as UnsubscribeRequestSchema,
    resourceUpdatedNotificationParamsSchema as ResourceUpdatedNotificationParamsSchema,
    resourceUpdatedNotificationSchema as ResourceUpdatedNotificationSchema,

    // Prompts
    promptArgumentSchema as PromptArgumentSchema,
    promptSchema as PromptSchema,
    listPromptsRequestSchema as ListPromptsRequestSchema,
    listPromptsResultSchema as ListPromptsResultSchema,
    getPromptRequestParamsSchema as GetPromptRequestParamsSchema,
    getPromptRequestSchema as GetPromptRequestSchema,
    getPromptResultSchema as GetPromptResultSchema,
    promptListChangedNotificationSchema as PromptListChangedNotificationSchema,

    // Content
    roleSchema as RoleSchema,
    annotationsSchema as AnnotationsSchema,
    textContentSchema as TextContentSchema,
    imageContentSchema as ImageContentSchema,
    audioContentSchema as AudioContentSchema,
    toolUseContentSchema as ToolUseContentSchema,
    embeddedResourceSchema as EmbeddedResourceSchema,
    resourceLinkSchema as ResourceLinkSchema,
    contentBlockSchema as ContentBlockSchema,
    promptMessageSchema as PromptMessageSchema,

    // Tools
    toolAnnotationsSchema as ToolAnnotationsSchema,
    toolSchema as ToolSchema,
    listToolsRequestSchema as ListToolsRequestSchema,
    listToolsResultSchema as ListToolsResultSchema,
    callToolResultSchema as CallToolResultSchema,
    callToolRequestParamsSchema as CallToolRequestParamsSchema,
    callToolRequestSchema as CallToolRequestSchema,
    toolListChangedNotificationSchema as ToolListChangedNotificationSchema,

    // Logging
    loggingLevelSchema as LoggingLevelSchema,
    setLevelRequestParamsSchema as SetLevelRequestParamsSchema,
    setLevelRequestSchema as SetLevelRequestSchema,
    loggingMessageNotificationParamsSchema as LoggingMessageNotificationParamsSchema,
    loggingMessageNotificationSchema as LoggingMessageNotificationSchema,

    // Sampling
    modelHintSchema as ModelHintSchema,
    modelPreferencesSchema as ModelPreferencesSchema,
    toolChoiceSchema as ToolChoiceSchema,
    toolResultContentSchema as ToolResultContentSchema,
    samplingMessageContentBlockSchema as SamplingMessageContentBlockSchema,
    samplingMessageSchema as SamplingMessageSchema,
    createMessageRequestParamsSchema as CreateMessageRequestParamsSchema,
    createMessageRequestSchema as CreateMessageRequestSchema,
    createMessageResultSchema as CreateMessageResultSchema,

    // Elicitation
    booleanSchemaSchema as BooleanSchemaSchema,
    stringSchemaSchema as StringSchemaSchema,
    numberSchemaSchema as NumberSchemaSchema,
    untitledSingleSelectEnumSchemaSchema as UntitledSingleSelectEnumSchemaSchema,
    titledSingleSelectEnumSchemaSchema as TitledSingleSelectEnumSchemaSchema,
    legacyTitledEnumSchemaSchema as LegacyTitledEnumSchemaSchema,
    singleSelectEnumSchemaSchema as SingleSelectEnumSchemaSchema,
    untitledMultiSelectEnumSchemaSchema as UntitledMultiSelectEnumSchemaSchema,
    titledMultiSelectEnumSchemaSchema as TitledMultiSelectEnumSchemaSchema,
    multiSelectEnumSchemaSchema as MultiSelectEnumSchemaSchema,
    enumSchemaSchema as EnumSchemaSchema,
    primitiveSchemaDefinitionSchema as PrimitiveSchemaDefinitionSchema,
    elicitRequestFormParamsSchema as ElicitRequestFormParamsSchema,
    elicitRequestUrlParamsSchema as ElicitRequestURLParamsSchema,
    elicitRequestParamsSchema as ElicitRequestParamsSchema,
    elicitRequestSchema as ElicitRequestSchema,
    elicitResultSchema as ElicitResultSchema,
    elicitationCompleteNotificationSchema as ElicitationCompleteNotificationSchema,

    // Autocomplete
    resourceTemplateReferenceSchema as ResourceTemplateReferenceSchema,
    promptReferenceSchema as PromptReferenceSchema,
    completeRequestParamsSchema as CompleteRequestParamsSchema,
    completeRequestSchema as CompleteRequestSchema,
    completeResultSchema as CompleteResultSchema,

    // Roots
    rootSchema as RootSchema,
    listRootsRequestSchema as ListRootsRequestSchema,
    listRootsResultSchema as ListRootsResultSchema,
    rootsListChangedNotificationSchema as RootsListChangedNotificationSchema,

    // Message aggregates
    clientRequestSchema as ClientRequestSchema,
    clientNotificationSchema as ClientNotificationSchema,
    clientResultSchema as ClientResultSchema,
    serverRequestSchema as ServerRequestSchema,
    serverNotificationSchema as ServerNotificationSchema,
    serverResultSchema as ServerResultSchema
} from './schemas.generated.js';

// Also export the original camelCase names for anyone who wants them
export * from './schemas.generated.js';
