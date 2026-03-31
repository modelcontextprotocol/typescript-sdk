// ⚠️  PUBLIC API — every export from this file is re-exported via `export *`
// in exports/public/index.ts and becomes part of the SDK's public surface.
// Only add MCP-spec-derived types here. Internal helpers belong elsewhere.

import type * as z from 'zod/v4';

import type { INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR } from './constants.js';
import type {
    AnnotationsSchema,
    AudioContentSchema,
    BaseMetadataSchema,
    BaseRequestParamsSchema,
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
    JSONRPCErrorResponseSchema,
    JSONRPCMessageSchema,
    JSONRPCNotificationSchema,
    JSONRPCRequestSchema,
    JSONRPCResponseSchema,
    JSONRPCResultResponseSchema,
    LegacyTitledEnumSchemaSchema,
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
    ModelHintSchema,
    ModelPreferencesSchema,
    MultiSelectEnumSchemaSchema,
    NotificationSchema,
    NotificationsParamsSchema,
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
    RelatedTaskMetadataSchema,
    RequestIdSchema,
    RequestMetaSchema,
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
    SetLevelRequestParamsSchema,
    SetLevelRequestSchema,
    SingleSelectEnumSchemaSchema,
    StringSchemaSchema,
    SubscribeRequestParamsSchema,
    SubscribeRequestSchema,
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
    UntitledSingleSelectEnumSchemaSchema
} from './schemas.js';

/* JSON types */
export type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
export type JSONObject = { [key: string]: JSONValue };
export type JSONArray = JSONValue[];

/**
 * Utility types
 */
type ExpandRecursively<T> = T extends object ? (T extends infer O ? { [K in keyof O]: ExpandRecursively<O[K]> } : never) : T;

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
// TODO: Overlaps with exported `ResourceTemplate` class from `server`.
export type ResourceTemplateType = Infer<typeof ResourceTemplateSchema>;
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
export type PromptReference = Infer<typeof PromptReferenceSchema>;
export type CompleteRequestParams = Infer<typeof CompleteRequestParamsSchema>;
export type CompleteRequest = Infer<typeof CompleteRequestSchema>;
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

/* Protocol type maps */
type MethodToTypeMap<U> = {
    [T in U as T extends { method: infer M extends string } ? M : never]: T;
};
export type RequestMethod = ClientRequest['method'] | ServerRequest['method'];
export type NotificationMethod = ClientNotification['method'] | ServerNotification['method'];
export type RequestTypeMap = MethodToTypeMap<ClientRequest | ServerRequest>;
export type NotificationTypeMap = MethodToTypeMap<ClientNotification | ServerNotification>;
export type ResultTypeMap = {
    ping: EmptyResult;
    initialize: InitializeResult;
    'completion/complete': CompleteResult;
    'logging/setLevel': EmptyResult;
    'prompts/get': GetPromptResult;
    'prompts/list': ListPromptsResult;
    'resources/list': ListResourcesResult;
    'resources/templates/list': ListResourceTemplatesResult;
    'resources/read': ReadResourceResult;
    'resources/subscribe': EmptyResult;
    'resources/unsubscribe': EmptyResult;
    'tools/call': CallToolResult | CreateTaskResult;
    'tools/list': ListToolsResult;
    'sampling/createMessage': CreateMessageResult | CreateMessageResultWithTools | CreateTaskResult;
    'elicitation/create': ElicitResult | CreateTaskResult;
    'roots/list': ListRootsResult;
    'tasks/get': GetTaskResult;
    'tasks/result': Result;
    'tasks/list': ListTasksResult;
    'tasks/cancel': CancelTaskResult;
};

/**
 * Information about a validated access token, provided to request handlers.
 */
export interface AuthInfo {
    /**
     * The access token.
     */
    token: string;

    /**
     * The client ID associated with this token.
     */
    clientId: string;

    /**
     * Scopes associated with this token.
     */
    scopes: string[];

    /**
     * When the token expires (in seconds since epoch).
     */
    expiresAt?: number;

    /**
     * The RFC 8707 resource server identifier for which this token is valid.
     * If set, this MUST match the MCP server's resource identifier (minus hash fragment).
     */
    resource?: URL;

    /**
     * Additional data associated with the token.
     * This field should be used for any additional data that needs to be attached to the auth info.
     */
    extra?: Record<string, unknown>;
}

type JSONRPCErrorObject = { code: number; message: string; data?: unknown };

export interface ParseError extends JSONRPCErrorObject {
    code: typeof PARSE_ERROR;
}
export interface InvalidRequestError extends JSONRPCErrorObject {
    code: typeof INVALID_REQUEST;
}
export interface MethodNotFoundError extends JSONRPCErrorObject {
    code: typeof METHOD_NOT_FOUND;
}
export interface InvalidParamsError extends JSONRPCErrorObject {
    code: typeof INVALID_PARAMS;
}
export interface InternalError extends JSONRPCErrorObject {
    code: typeof INTERNAL_ERROR;
}

/**
 * Callback type for list changed notifications.
 */
export type ListChangedCallback<T> = (error: Error | null, items: T[] | null) => void;

/**
 * Options for subscribing to list changed notifications.
 *
 * @typeParam T - The type of items in the list (`Tool`, `Prompt`, or `Resource`)
 */
export type ListChangedOptions<T> = {
    /**
     * If `true`, the list will be refreshed automatically when a list changed notification is received.
     * @default true
     */
    autoRefresh?: boolean;
    /**
     * Debounce time in milliseconds. Set to `0` to disable.
     * @default 300
     */
    debounceMs?: number;
    /**
     * Callback invoked when the list changes.
     *
     * If `autoRefresh` is `true`, `items` contains the updated list.
     * If `autoRefresh` is `false`, `items` is `null` (caller should refresh manually).
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

/**
 * Extra information about a message.
 */
export interface MessageExtraInfo {
    /**
     * The original HTTP request.
     */
    request?: globalThis.Request;

    /**
     * The authentication information.
     */
    authInfo?: AuthInfo;

    /**
     * Callback to close the SSE stream for this request, triggering client reconnection.
     * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
     */
    closeSSEStream?: () => void;

    /**
     * Callback to close the standalone GET SSE stream, triggering client reconnection.
     * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
     */
    closeStandaloneSSEStream?: () => void;
}

export type MetaObject = Record<string, unknown>;
export type RequestMetaObject = RequestMeta;

/**
 * {@linkcode CreateMessageRequestParams} without tools - for backwards-compatible overload.
 * Excludes tools/toolChoice to indicate they should not be provided.
 */
export type CreateMessageRequestParamsBase = Omit<CreateMessageRequestParams, 'tools' | 'toolChoice'>;

/**
 * {@linkcode CreateMessageRequestParams} with required tools - for tool-enabled overload.
 */
export interface CreateMessageRequestParamsWithTools extends CreateMessageRequestParams {
    tools: Tool[];
}

export type CompleteRequestResourceTemplate = ExpandRecursively<
    CompleteRequest & { params: CompleteRequestParams & { ref: ResourceTemplateReference } }
>;
export type CompleteRequestPrompt = ExpandRecursively<CompleteRequest & { params: CompleteRequestParams & { ref: PromptReference } }>;
