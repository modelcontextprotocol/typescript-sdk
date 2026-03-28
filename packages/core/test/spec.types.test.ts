/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the SDK's types
 *   (mutually assignable — no type-level workarounds should be needed)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import fs from 'node:fs';
import path from 'node:path';

import type * as SpecTypes from '../src/types/spec.types.js';
import type * as SDKTypes from '../src/types/index.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

// Adds the `jsonrpc` property to a type, to match the on-wire format of notifications.
type WithJSONRPC<T> = T & { jsonrpc: '2.0' };

// Adds the `jsonrpc` and `id` properties to a type, to match the on-wire format of requests.
type WithJSONRPCRequest<T> = T & { jsonrpc: '2.0'; id: SDKTypes.RequestId };

// The spec defines typed *ResultResponse interfaces (e.g. InitializeResultResponse) that pair a
// JSONRPCResultResponse envelope with a specific result type. The SDK doesn't export these because
// nothing in the SDK needs the combined type — Protocol._onresponse() unwraps the envelope and
// validates the inner result separately. We define this locally to verify the composition still
// type-checks against the spec without polluting the SDK's public API.
type TypedResultResponse<R extends SDKTypes.Result> = SDKTypes.JSONRPCResultResponse & { result: R };

const sdkTypeChecks = {
    RequestParams: (sdk: SDKTypes.RequestParams, spec: SpecTypes.RequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    NotificationParams: (sdk: SDKTypes.NotificationParams, spec: SpecTypes.NotificationParams) => {
        sdk = spec;
        spec = sdk;
    },
    CancelledNotificationParams: (sdk: SDKTypes.CancelledNotificationParams, spec: SpecTypes.CancelledNotificationParams) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeRequestParams: (sdk: SDKTypes.InitializeRequestParams, spec: SpecTypes.InitializeRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ProgressNotificationParams: (sdk: SDKTypes.ProgressNotificationParams, spec: SpecTypes.ProgressNotificationParams) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceRequestParams: (sdk: SDKTypes.ResourceRequestParams, spec: SpecTypes.ResourceRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceRequestParams: (sdk: SDKTypes.ReadResourceRequestParams, spec: SpecTypes.ReadResourceRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeRequestParams: (sdk: SDKTypes.SubscribeRequestParams, spec: SpecTypes.SubscribeRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeRequestParams: (sdk: SDKTypes.UnsubscribeRequestParams, spec: SpecTypes.UnsubscribeRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceUpdatedNotificationParams: (
        sdk: SDKTypes.ResourceUpdatedNotificationParams,
        spec: SpecTypes.ResourceUpdatedNotificationParams
    ) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptRequestParams: (sdk: SDKTypes.GetPromptRequestParams, spec: SpecTypes.GetPromptRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolRequestParams: (sdk: SDKTypes.CallToolRequestParams, spec: SpecTypes.CallToolRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelRequestParams: (sdk: SDKTypes.SetLevelRequestParams, spec: SpecTypes.SetLevelRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingMessageNotificationParams: (
        sdk: SDKTypes.LoggingMessageNotificationParams,
        spec: SpecTypes.LoggingMessageNotificationParams
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageRequestParams: (sdk: SDKTypes.CreateMessageRequestParams, spec: SpecTypes.CreateMessageRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequestParams: (sdk: SDKTypes.CompleteRequestParams, spec: SpecTypes.CompleteRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequestParams: (sdk: SDKTypes.ElicitRequestParams, spec: SpecTypes.ElicitRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequestFormParams: (sdk: SDKTypes.ElicitRequestFormParams, spec: SpecTypes.ElicitRequestFormParams) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequestURLParams: (sdk: SDKTypes.ElicitRequestURLParams, spec: SpecTypes.ElicitRequestURLParams) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitationCompleteNotification: (
        sdk: WithJSONRPC<SDKTypes.ElicitationCompleteNotification>,
        spec: SpecTypes.ElicitationCompleteNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequestParams: (sdk: SDKTypes.PaginatedRequestParams, spec: SpecTypes.PaginatedRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    CancelledNotification: (sdk: WithJSONRPC<SDKTypes.CancelledNotification>, spec: SpecTypes.CancelledNotification) => {
        sdk = spec;
        spec = sdk;
    },
    BaseMetadata: (sdk: SDKTypes.BaseMetadata, spec: SpecTypes.BaseMetadata) => {
        sdk = spec;
        spec = sdk;
    },
    Implementation: (sdk: SDKTypes.Implementation, spec: SpecTypes.Implementation) => {
        sdk = spec;
        spec = sdk;
    },
    ProgressNotification: (sdk: WithJSONRPC<SDKTypes.ProgressNotification>, spec: SpecTypes.ProgressNotification) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeRequest: (sdk: WithJSONRPCRequest<SDKTypes.SubscribeRequest>, spec: SpecTypes.SubscribeRequest) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeRequest: (sdk: WithJSONRPCRequest<SDKTypes.UnsubscribeRequest>, spec: SpecTypes.UnsubscribeRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequest: (sdk: WithJSONRPCRequest<SDKTypes.PaginatedRequest>, spec: SpecTypes.PaginatedRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedResult: (sdk: SDKTypes.PaginatedResult, spec: SpecTypes.PaginatedResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListRootsRequest>, spec: SpecTypes.ListRootsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsResult: (sdk: SDKTypes.ListRootsResult, spec: SpecTypes.ListRootsResult) => {
        sdk = spec;
        spec = sdk;
    },
    Root: (sdk: SDKTypes.Root, spec: SpecTypes.Root) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequest: (sdk: WithJSONRPCRequest<SDKTypes.ElicitRequest>, spec: SpecTypes.ElicitRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitResult: (sdk: SDKTypes.ElicitResult, spec: SpecTypes.ElicitResult) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequest: (sdk: WithJSONRPCRequest<SDKTypes.CompleteRequest>, spec: SpecTypes.CompleteRequest) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteResult: (sdk: SDKTypes.CompleteResult, spec: SpecTypes.CompleteResult) => {
        sdk = spec;
        spec = sdk;
    },
    ProgressToken: (sdk: SDKTypes.ProgressToken, spec: SpecTypes.ProgressToken) => {
        sdk = spec;
        spec = sdk;
    },
    Cursor: (sdk: SDKTypes.Cursor, spec: SpecTypes.Cursor) => {
        sdk = spec;
        spec = sdk;
    },
    Request: (sdk: SDKTypes.Request, spec: SpecTypes.Request) => {
        sdk = spec;
        spec = sdk;
    },
    Result: (sdk: SDKTypes.Result, spec: SpecTypes.Result) => {
        sdk = spec;
        spec = sdk;
    },
    RequestId: (sdk: SDKTypes.RequestId, spec: SpecTypes.RequestId) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCRequest: (sdk: SDKTypes.JSONRPCRequest, spec: SpecTypes.JSONRPCRequest) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCNotification: (sdk: SDKTypes.JSONRPCNotification, spec: SpecTypes.JSONRPCNotification) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCResponse: (sdk: SDKTypes.JSONRPCResponse, spec: SpecTypes.JSONRPCResponse) => {
        sdk = spec;
        spec = sdk;
    },
    EmptyResult: (sdk: SDKTypes.EmptyResult, spec: SpecTypes.EmptyResult) => {
        sdk = spec;
        spec = sdk;
    },
    Notification: (sdk: SDKTypes.Notification, spec: SpecTypes.Notification) => {
        sdk = spec;
        spec = sdk;
    },
    ClientResult: (sdk: SDKTypes.ClientResult, spec: SpecTypes.ClientResult) => {
        sdk = spec;
        spec = sdk;
    },
    ClientNotification: (sdk: WithJSONRPC<SDKTypes.ClientNotification>, spec: SpecTypes.ClientNotification) => {
        sdk = spec;
        spec = sdk;
    },
    ServerResult: (sdk: SDKTypes.ServerResult, spec: SpecTypes.ServerResult) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceTemplateReference: (sdk: SDKTypes.ResourceTemplateReference, spec: SpecTypes.ResourceTemplateReference) => {
        sdk = spec;
        spec = sdk;
    },
    PromptReference: (sdk: SDKTypes.PromptReference, spec: SpecTypes.PromptReference) => {
        sdk = spec;
        spec = sdk;
    },
    ToolAnnotations: (sdk: SDKTypes.ToolAnnotations, spec: SpecTypes.ToolAnnotations) => {
        sdk = spec;
        spec = sdk;
    },
    Tool: (sdk: SDKTypes.Tool, spec: SpecTypes.Tool) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListToolsRequest>, spec: SpecTypes.ListToolsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResult: (sdk: SDKTypes.ListToolsResult, spec: SpecTypes.ListToolsResult) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolResult: (sdk: SDKTypes.CallToolResult, spec: SpecTypes.CallToolResult) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolRequest: (sdk: WithJSONRPCRequest<SDKTypes.CallToolRequest>, spec: SpecTypes.CallToolRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ToolListChangedNotification: (sdk: WithJSONRPC<SDKTypes.ToolListChangedNotification>, spec: SpecTypes.ToolListChangedNotification) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceListChangedNotification: (
        sdk: WithJSONRPC<SDKTypes.ResourceListChangedNotification>,
        spec: SpecTypes.ResourceListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    PromptListChangedNotification: (
        sdk: WithJSONRPC<SDKTypes.PromptListChangedNotification>,
        spec: SpecTypes.PromptListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    RootsListChangedNotification: (
        sdk: WithJSONRPC<SDKTypes.RootsListChangedNotification>,
        spec: SpecTypes.RootsListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceUpdatedNotification: (sdk: WithJSONRPC<SDKTypes.ResourceUpdatedNotification>, spec: SpecTypes.ResourceUpdatedNotification) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessage: (sdk: SDKTypes.SamplingMessage, spec: SpecTypes.SamplingMessage) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageResult: (sdk: SDKTypes.CreateMessageResultWithTools, spec: SpecTypes.CreateMessageResult) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelRequest: (sdk: WithJSONRPCRequest<SDKTypes.SetLevelRequest>, spec: SpecTypes.SetLevelRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PingRequest: (sdk: WithJSONRPCRequest<SDKTypes.PingRequest>, spec: SpecTypes.PingRequest) => {
        sdk = spec;
        spec = sdk;
    },
    InitializedNotification: (sdk: WithJSONRPC<SDKTypes.InitializedNotification>, spec: SpecTypes.InitializedNotification) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListResourcesRequest>, spec: SpecTypes.ListResourcesRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResult: (sdk: SDKTypes.ListResourcesResult, spec: SpecTypes.ListResourcesResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesRequest: (
        sdk: WithJSONRPCRequest<SDKTypes.ListResourceTemplatesRequest>,
        spec: SpecTypes.ListResourceTemplatesRequest
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResult: (sdk: SDKTypes.ListResourceTemplatesResult, spec: SpecTypes.ListResourceTemplatesResult) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceRequest: (sdk: WithJSONRPCRequest<SDKTypes.ReadResourceRequest>, spec: SpecTypes.ReadResourceRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceResult: (sdk: SDKTypes.ReadResourceResult, spec: SpecTypes.ReadResourceResult) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceContents: (sdk: SDKTypes.ResourceContents, spec: SpecTypes.ResourceContents) => {
        sdk = spec;
        spec = sdk;
    },
    TextResourceContents: (sdk: SDKTypes.TextResourceContents, spec: SpecTypes.TextResourceContents) => {
        sdk = spec;
        spec = sdk;
    },
    BlobResourceContents: (sdk: SDKTypes.BlobResourceContents, spec: SpecTypes.BlobResourceContents) => {
        sdk = spec;
        spec = sdk;
    },
    Resource: (sdk: SDKTypes.Resource, spec: SpecTypes.Resource) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceTemplate: (sdk: SDKTypes.ResourceTemplateType, spec: SpecTypes.ResourceTemplate) => {
        sdk = spec;
        spec = sdk;
    },
    PromptArgument: (sdk: SDKTypes.PromptArgument, spec: SpecTypes.PromptArgument) => {
        sdk = spec;
        spec = sdk;
    },
    Prompt: (sdk: SDKTypes.Prompt, spec: SpecTypes.Prompt) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListPromptsRequest>, spec: SpecTypes.ListPromptsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResult: (sdk: SDKTypes.ListPromptsResult, spec: SpecTypes.ListPromptsResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetPromptRequest>, spec: SpecTypes.GetPromptRequest) => {
        sdk = spec;
        spec = sdk;
    },
    TextContent: (sdk: SDKTypes.TextContent, spec: SpecTypes.TextContent) => {
        sdk = spec;
        spec = sdk;
    },
    ImageContent: (sdk: SDKTypes.ImageContent, spec: SpecTypes.ImageContent) => {
        sdk = spec;
        spec = sdk;
    },
    AudioContent: (sdk: SDKTypes.AudioContent, spec: SpecTypes.AudioContent) => {
        sdk = spec;
        spec = sdk;
    },
    EmbeddedResource: (sdk: SDKTypes.EmbeddedResource, spec: SpecTypes.EmbeddedResource) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceLink: (sdk: SDKTypes.ResourceLink, spec: SpecTypes.ResourceLink) => {
        sdk = spec;
        spec = sdk;
    },
    ContentBlock: (sdk: SDKTypes.ContentBlock, spec: SpecTypes.ContentBlock) => {
        sdk = spec;
        spec = sdk;
    },
    PromptMessage: (sdk: SDKTypes.PromptMessage, spec: SpecTypes.PromptMessage) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptResult: (sdk: SDKTypes.GetPromptResult, spec: SpecTypes.GetPromptResult) => {
        sdk = spec;
        spec = sdk;
    },
    BooleanSchema: (sdk: SDKTypes.BooleanSchema, spec: SpecTypes.BooleanSchema) => {
        sdk = spec;
        spec = sdk;
    },
    StringSchema: (sdk: SDKTypes.StringSchema, spec: SpecTypes.StringSchema) => {
        sdk = spec;
        spec = sdk;
    },
    NumberSchema: (sdk: SDKTypes.NumberSchema, spec: SpecTypes.NumberSchema) => {
        sdk = spec;
        spec = sdk;
    },
    EnumSchema: (sdk: SDKTypes.EnumSchema, spec: SpecTypes.EnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    UntitledSingleSelectEnumSchema: (sdk: SDKTypes.UntitledSingleSelectEnumSchema, spec: SpecTypes.UntitledSingleSelectEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    TitledSingleSelectEnumSchema: (sdk: SDKTypes.TitledSingleSelectEnumSchema, spec: SpecTypes.TitledSingleSelectEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    SingleSelectEnumSchema: (sdk: SDKTypes.SingleSelectEnumSchema, spec: SpecTypes.SingleSelectEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    UntitledMultiSelectEnumSchema: (sdk: SDKTypes.UntitledMultiSelectEnumSchema, spec: SpecTypes.UntitledMultiSelectEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    TitledMultiSelectEnumSchema: (sdk: SDKTypes.TitledMultiSelectEnumSchema, spec: SpecTypes.TitledMultiSelectEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    MultiSelectEnumSchema: (sdk: SDKTypes.MultiSelectEnumSchema, spec: SpecTypes.MultiSelectEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    LegacyTitledEnumSchema: (sdk: SDKTypes.LegacyTitledEnumSchema, spec: SpecTypes.LegacyTitledEnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    PrimitiveSchemaDefinition: (sdk: SDKTypes.PrimitiveSchemaDefinition, spec: SpecTypes.PrimitiveSchemaDefinition) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCErrorResponse: (sdk: SDKTypes.JSONRPCErrorResponse, spec: SpecTypes.JSONRPCErrorResponse) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCResultResponse: (sdk: SDKTypes.JSONRPCResultResponse, spec: SpecTypes.JSONRPCResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCMessage: (sdk: SDKTypes.JSONRPCMessage, spec: SpecTypes.JSONRPCMessage) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageRequest: (sdk: WithJSONRPCRequest<SDKTypes.CreateMessageRequest>, spec: SpecTypes.CreateMessageRequest) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeRequest: (sdk: WithJSONRPCRequest<SDKTypes.InitializeRequest>, spec: SpecTypes.InitializeRequest) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeResult: (sdk: SDKTypes.InitializeResult, spec: SpecTypes.InitializeResult) => {
        sdk = spec;
        spec = sdk;
    },
    ClientCapabilities: (sdk: SDKTypes.ClientCapabilities, spec: SpecTypes.ClientCapabilities) => {
        sdk = spec;
        spec = sdk;
    },
    ServerCapabilities: (sdk: SDKTypes.ServerCapabilities, spec: SpecTypes.ServerCapabilities) => {
        sdk = spec;
        spec = sdk;
    },
    ClientRequest: (sdk: WithJSONRPCRequest<SDKTypes.ClientRequest>, spec: SpecTypes.ClientRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ServerRequest: (sdk: WithJSONRPCRequest<SDKTypes.ServerRequest>, spec: SpecTypes.ServerRequest) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingMessageNotification: (sdk: WithJSONRPC<SDKTypes.LoggingMessageNotification>, spec: SpecTypes.LoggingMessageNotification) => {
        sdk = spec;
        spec = sdk;
    },
    ServerNotification: (sdk: WithJSONRPC<SDKTypes.ServerNotification>, spec: SpecTypes.ServerNotification) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingLevel: (sdk: SDKTypes.LoggingLevel, spec: SpecTypes.LoggingLevel) => {
        sdk = spec;
        spec = sdk;
    },
    Icon: (sdk: SDKTypes.Icon, spec: SpecTypes.Icon) => {
        sdk = spec;
        spec = sdk;
    },
    Icons: (sdk: SDKTypes.Icons, spec: SpecTypes.Icons) => {
        sdk = spec;
        spec = sdk;
    },
    ModelHint: (sdk: SDKTypes.ModelHint, spec: SpecTypes.ModelHint) => {
        sdk = spec;
        spec = sdk;
    },
    ModelPreferences: (sdk: SDKTypes.ModelPreferences, spec: SpecTypes.ModelPreferences) => {
        sdk = spec;
        spec = sdk;
    },
    ToolChoice: (sdk: SDKTypes.ToolChoice, spec: SpecTypes.ToolChoice) => {
        sdk = spec;
        spec = sdk;
    },
    ToolUseContent: (sdk: SDKTypes.ToolUseContent, spec: SpecTypes.ToolUseContent) => {
        sdk = spec;
        spec = sdk;
    },
    ToolResultContent: (sdk: SDKTypes.ToolResultContent, spec: SpecTypes.ToolResultContent) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessageContentBlock: (sdk: SDKTypes.SamplingMessageContentBlock, spec: SpecTypes.SamplingMessageContentBlock) => {
        sdk = spec;
        spec = sdk;
    },
    Annotations: (sdk: SDKTypes.Annotations, spec: SpecTypes.Annotations) => {
        sdk = spec;
        spec = sdk;
    },
    Role: (sdk: SDKTypes.Role, spec: SpecTypes.Role) => {
        sdk = spec;
        spec = sdk;
    },
    TaskAugmentedRequestParams: (sdk: SDKTypes.TaskAugmentedRequestParams, spec: SpecTypes.TaskAugmentedRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ToolExecution: (sdk: SDKTypes.ToolExecution, spec: SpecTypes.ToolExecution) => {
        sdk = spec;
        spec = sdk;
    },
    TaskStatus: (sdk: SDKTypes.TaskStatus, spec: SpecTypes.TaskStatus) => {
        sdk = spec;
        spec = sdk;
    },
    TaskMetadata: (sdk: SDKTypes.TaskMetadata, spec: SpecTypes.TaskMetadata) => {
        sdk = spec;
        spec = sdk;
    },
    RelatedTaskMetadata: (sdk: SDKTypes.RelatedTaskMetadata, spec: SpecTypes.RelatedTaskMetadata) => {
        sdk = spec;
        spec = sdk;
    },
    Task: (sdk: SDKTypes.Task, spec: SpecTypes.Task) => {
        sdk = spec;
        spec = sdk;
    },
    CreateTaskResult: (sdk: SDKTypes.CreateTaskResult, spec: SpecTypes.CreateTaskResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskResult: (sdk: SDKTypes.GetTaskResult, spec: SpecTypes.GetTaskResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskPayloadRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetTaskPayloadRequest>, spec: SpecTypes.GetTaskPayloadRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListTasksRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListTasksRequest>, spec: SpecTypes.ListTasksRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListTasksResult: (sdk: SDKTypes.ListTasksResult, spec: SpecTypes.ListTasksResult) => {
        sdk = spec;
        spec = sdk;
    },
    CancelTaskRequest: (sdk: WithJSONRPCRequest<SDKTypes.CancelTaskRequest>, spec: SpecTypes.CancelTaskRequest) => {
        sdk = spec;
        spec = sdk;
    },
    CancelTaskResult: (sdk: SDKTypes.CancelTaskResult, spec: SpecTypes.CancelTaskResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetTaskRequest>, spec: SpecTypes.GetTaskRequest) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskPayloadResult: (sdk: SDKTypes.GetTaskPayloadResult, spec: SpecTypes.GetTaskPayloadResult) => {
        sdk = spec;
        spec = sdk;
    },
    TaskStatusNotificationParams: (sdk: SDKTypes.TaskStatusNotificationParams, spec: SpecTypes.TaskStatusNotificationParams) => {
        sdk = spec;
        spec = sdk;
    },
    TaskStatusNotification: (sdk: WithJSONRPC<SDKTypes.TaskStatusNotification>, spec: SpecTypes.TaskStatusNotification) => {
        sdk = spec;
        spec = sdk;
    },

    /* JSON primitives */
    JSONValue: (sdk: SDKTypes.JSONValue, spec: SpecTypes.JSONValue) => {
        sdk = spec;
        spec = sdk;
    },
    JSONObject: (sdk: SDKTypes.JSONObject, spec: SpecTypes.JSONObject) => {
        sdk = spec;
        spec = sdk;
    },
    JSONArray: (sdk: SDKTypes.JSONArray, spec: SpecTypes.JSONArray) => {
        sdk = spec;
        spec = sdk;
    },

    /* Meta types */
    MetaObject: (sdk: SDKTypes.MetaObject, spec: SpecTypes.MetaObject) => {
        sdk = spec;
        spec = sdk;
    },
    RequestMetaObject: (sdk: SDKTypes.RequestMetaObject, spec: SpecTypes.RequestMetaObject) => {
        sdk = spec;
        spec = sdk;
    },

    /* Error types */
    ParseError: (sdk: SDKTypes.ParseError, spec: SpecTypes.ParseError) => {
        sdk = spec;
        spec = sdk;
    },
    InvalidRequestError: (sdk: SDKTypes.InvalidRequestError, spec: SpecTypes.InvalidRequestError) => {
        sdk = spec;
        spec = sdk;
    },
    MethodNotFoundError: (sdk: SDKTypes.MethodNotFoundError, spec: SpecTypes.MethodNotFoundError) => {
        sdk = spec;
        spec = sdk;
    },
    InvalidParamsError: (sdk: SDKTypes.InvalidParamsError, spec: SpecTypes.InvalidParamsError) => {
        sdk = spec;
        spec = sdk;
    },
    InternalError: (sdk: SDKTypes.InternalError, spec: SpecTypes.InternalError) => {
        sdk = spec;
        spec = sdk;
    },

    /* ResultResponse types — see TypedResultResponse comment above */
    InitializeResultResponse: (sdk: TypedResultResponse<SDKTypes.InitializeResult>, spec: SpecTypes.InitializeResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    PingResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: SpecTypes.PingResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResultResponse: (sdk: TypedResultResponse<SDKTypes.ListResourcesResult>, spec: SpecTypes.ListResourcesResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResultResponse: (
        sdk: TypedResultResponse<SDKTypes.ListResourceTemplatesResult>,
        spec: SpecTypes.ListResourceTemplatesResultResponse
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceResultResponse: (sdk: TypedResultResponse<SDKTypes.ReadResourceResult>, spec: SpecTypes.ReadResourceResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: SpecTypes.SubscribeResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: SpecTypes.UnsubscribeResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResultResponse: (sdk: TypedResultResponse<SDKTypes.ListPromptsResult>, spec: SpecTypes.ListPromptsResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptResultResponse: (sdk: TypedResultResponse<SDKTypes.GetPromptResult>, spec: SpecTypes.GetPromptResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResultResponse: (sdk: TypedResultResponse<SDKTypes.ListToolsResult>, spec: SpecTypes.ListToolsResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolResultResponse: (sdk: TypedResultResponse<SDKTypes.CallToolResult>, spec: SpecTypes.CallToolResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    CreateTaskResultResponse: (sdk: TypedResultResponse<SDKTypes.CreateTaskResult>, spec: SpecTypes.CreateTaskResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskResultResponse: (sdk: TypedResultResponse<SDKTypes.GetTaskResult>, spec: SpecTypes.GetTaskResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskPayloadResultResponse: (
        sdk: TypedResultResponse<SDKTypes.GetTaskPayloadResult>,
        spec: SpecTypes.GetTaskPayloadResultResponse
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CancelTaskResultResponse: (sdk: TypedResultResponse<SDKTypes.CancelTaskResult>, spec: SpecTypes.CancelTaskResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListTasksResultResponse: (sdk: TypedResultResponse<SDKTypes.ListTasksResult>, spec: SpecTypes.ListTasksResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: SpecTypes.SetLevelResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageResultResponse: (
        sdk: TypedResultResponse<SDKTypes.CreateMessageResultWithTools>,
        spec: SpecTypes.CreateMessageResultResponse
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteResultResponse: (sdk: TypedResultResponse<SDKTypes.CompleteResult>, spec: SpecTypes.CompleteResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsResultResponse: (sdk: TypedResultResponse<SDKTypes.ListRootsResult>, spec: SpecTypes.ListRootsResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitResultResponse: (sdk: TypedResultResponse<SDKTypes.ElicitResult>, spec: SpecTypes.ElicitResultResponse) => {
        sdk = spec;
        spec = sdk;
    }
};

// ---------------------------------------------------------------------------
// Key-level assertions: verify that each SDK type and its corresponding spec
// type expose exactly the same set of named property keys. This catches cases
// where a Zod schema marks a field as `.optional()` but the spec does not (or
// vice-versa), which the mutual-assignability checks above cannot detect
// because optional fields satisfy structural subtyping in both directions.
// ---------------------------------------------------------------------------

/** Strip index signatures, keeping only explicitly-named keys. */
type KnownKeys<T> = keyof {
    [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};

/**
 * Assert that A and B have exactly the same set of known (named) keys.
 * Resolves to `true` on match; a descriptive error type on mismatch.
 */
type AssertExactKeys<
    A,
    B,
    Extra extends PropertyKey = Exclude<KnownKeys<A>, KnownKeys<B>>,
    Missing extends PropertyKey = Exclude<KnownKeys<B>, KnownKeys<A>>
> = [Extra, Missing] extends [never, never] ? true : { _brand: 'KeyMismatch'; extra: Extra; missing: Missing };

/** Constraint: T must resolve to `true`. */
type Assert<T extends true> = T;

/*
 * Excluded from key-level assertions (23 entries):
 *
 * Union types — KnownKeys cannot meaningfully enumerate their members (15):
 *   ClientRequest, ServerRequest, ClientNotification, ServerNotification,
 *   ClientResult, ServerResult, JSONRPCMessage, JSONRPCResponse, ContentBlock,
 *   SamplingMessageContentBlock, ElicitRequestParams, PrimitiveSchemaDefinition,
 *   SingleSelectEnumSchema, MultiSelectEnumSchema, EnumSchema
 *
 * Primitive type aliases — no object keys to compare (8):
 *   JSONValue, JSONArray, Role, LoggingLevel, ProgressToken, RequestId,
 *   Cursor, TaskStatus
 */

// -- Simple types (96) --

type _K_RequestParams = Assert<AssertExactKeys<SDKTypes.RequestParams, SpecTypes.RequestParams>>;
type _K_NotificationParams = Assert<AssertExactKeys<SDKTypes.NotificationParams, SpecTypes.NotificationParams>>;
type _K_CancelledNotificationParams = Assert<AssertExactKeys<SDKTypes.CancelledNotificationParams, SpecTypes.CancelledNotificationParams>>;
type _K_InitializeRequestParams = Assert<AssertExactKeys<SDKTypes.InitializeRequestParams, SpecTypes.InitializeRequestParams>>;
type _K_ProgressNotificationParams = Assert<AssertExactKeys<SDKTypes.ProgressNotificationParams, SpecTypes.ProgressNotificationParams>>;
type _K_ResourceRequestParams = Assert<AssertExactKeys<SDKTypes.ResourceRequestParams, SpecTypes.ResourceRequestParams>>;
type _K_ReadResourceRequestParams = Assert<AssertExactKeys<SDKTypes.ReadResourceRequestParams, SpecTypes.ReadResourceRequestParams>>;
type _K_SubscribeRequestParams = Assert<AssertExactKeys<SDKTypes.SubscribeRequestParams, SpecTypes.SubscribeRequestParams>>;
type _K_UnsubscribeRequestParams = Assert<AssertExactKeys<SDKTypes.UnsubscribeRequestParams, SpecTypes.UnsubscribeRequestParams>>;
type _K_ResourceUpdatedNotificationParams = Assert<
    AssertExactKeys<SDKTypes.ResourceUpdatedNotificationParams, SpecTypes.ResourceUpdatedNotificationParams>
>;
type _K_GetPromptRequestParams = Assert<AssertExactKeys<SDKTypes.GetPromptRequestParams, SpecTypes.GetPromptRequestParams>>;
type _K_CallToolRequestParams = Assert<AssertExactKeys<SDKTypes.CallToolRequestParams, SpecTypes.CallToolRequestParams>>;
type _K_SetLevelRequestParams = Assert<AssertExactKeys<SDKTypes.SetLevelRequestParams, SpecTypes.SetLevelRequestParams>>;
type _K_LoggingMessageNotificationParams = Assert<
    AssertExactKeys<SDKTypes.LoggingMessageNotificationParams, SpecTypes.LoggingMessageNotificationParams>
>;
type _K_CreateMessageRequestParams = Assert<AssertExactKeys<SDKTypes.CreateMessageRequestParams, SpecTypes.CreateMessageRequestParams>>;
type _K_CompleteRequestParams = Assert<AssertExactKeys<SDKTypes.CompleteRequestParams, SpecTypes.CompleteRequestParams>>;
type _K_ElicitRequestFormParams = Assert<AssertExactKeys<SDKTypes.ElicitRequestFormParams, SpecTypes.ElicitRequestFormParams>>;
type _K_ElicitRequestURLParams = Assert<AssertExactKeys<SDKTypes.ElicitRequestURLParams, SpecTypes.ElicitRequestURLParams>>;
type _K_PaginatedRequestParams = Assert<AssertExactKeys<SDKTypes.PaginatedRequestParams, SpecTypes.PaginatedRequestParams>>;
type _K_BaseMetadata = Assert<AssertExactKeys<SDKTypes.BaseMetadata, SpecTypes.BaseMetadata>>;
type _K_Implementation = Assert<AssertExactKeys<SDKTypes.Implementation, SpecTypes.Implementation>>;
type _K_PaginatedResult = Assert<AssertExactKeys<SDKTypes.PaginatedResult, SpecTypes.PaginatedResult>>;
type _K_ListRootsResult = Assert<AssertExactKeys<SDKTypes.ListRootsResult, SpecTypes.ListRootsResult>>;
type _K_Root = Assert<AssertExactKeys<SDKTypes.Root, SpecTypes.Root>>;
type _K_ElicitResult = Assert<AssertExactKeys<SDKTypes.ElicitResult, SpecTypes.ElicitResult>>;
type _K_CompleteResult = Assert<AssertExactKeys<SDKTypes.CompleteResult, SpecTypes.CompleteResult>>;
type _K_Request = Assert<AssertExactKeys<SDKTypes.Request, SpecTypes.Request>>;
type _K_Result = Assert<AssertExactKeys<SDKTypes.Result, SpecTypes.Result>>;
type _K_JSONRPCRequest = Assert<AssertExactKeys<SDKTypes.JSONRPCRequest, SpecTypes.JSONRPCRequest>>;
type _K_JSONRPCNotification = Assert<AssertExactKeys<SDKTypes.JSONRPCNotification, SpecTypes.JSONRPCNotification>>;
type _K_EmptyResult = Assert<AssertExactKeys<SDKTypes.EmptyResult, SpecTypes.EmptyResult>>;
type _K_Notification = Assert<AssertExactKeys<SDKTypes.Notification, SpecTypes.Notification>>;
type _K_ResourceTemplateReference = Assert<AssertExactKeys<SDKTypes.ResourceTemplateReference, SpecTypes.ResourceTemplateReference>>;
// @ts-expect-error Genuine mismatch: SDK PromptReference is missing 'title' from spec
type _K_PromptReference = Assert<AssertExactKeys<SDKTypes.PromptReference, SpecTypes.PromptReference>>;
type _K_ToolAnnotations = Assert<AssertExactKeys<SDKTypes.ToolAnnotations, SpecTypes.ToolAnnotations>>;
type _K_Tool = Assert<AssertExactKeys<SDKTypes.Tool, SpecTypes.Tool>>;
type _K_ListToolsResult = Assert<AssertExactKeys<SDKTypes.ListToolsResult, SpecTypes.ListToolsResult>>;
type _K_CallToolResult = Assert<AssertExactKeys<SDKTypes.CallToolResult, SpecTypes.CallToolResult>>;
type _K_ListResourcesResult = Assert<AssertExactKeys<SDKTypes.ListResourcesResult, SpecTypes.ListResourcesResult>>;
type _K_ListResourceTemplatesResult = Assert<AssertExactKeys<SDKTypes.ListResourceTemplatesResult, SpecTypes.ListResourceTemplatesResult>>;
type _K_ReadResourceResult = Assert<AssertExactKeys<SDKTypes.ReadResourceResult, SpecTypes.ReadResourceResult>>;
type _K_ResourceContents = Assert<AssertExactKeys<SDKTypes.ResourceContents, SpecTypes.ResourceContents>>;
type _K_TextResourceContents = Assert<AssertExactKeys<SDKTypes.TextResourceContents, SpecTypes.TextResourceContents>>;
type _K_BlobResourceContents = Assert<AssertExactKeys<SDKTypes.BlobResourceContents, SpecTypes.BlobResourceContents>>;
type _K_Resource = Assert<AssertExactKeys<SDKTypes.Resource, SpecTypes.Resource>>;
// @ts-expect-error Genuine mismatch: SDK PromptArgument is missing 'title' from spec
type _K_PromptArgument = Assert<AssertExactKeys<SDKTypes.PromptArgument, SpecTypes.PromptArgument>>;
type _K_Prompt = Assert<AssertExactKeys<SDKTypes.Prompt, SpecTypes.Prompt>>;
type _K_ListPromptsResult = Assert<AssertExactKeys<SDKTypes.ListPromptsResult, SpecTypes.ListPromptsResult>>;
type _K_GetPromptResult = Assert<AssertExactKeys<SDKTypes.GetPromptResult, SpecTypes.GetPromptResult>>;
type _K_TextContent = Assert<AssertExactKeys<SDKTypes.TextContent, SpecTypes.TextContent>>;
type _K_ImageContent = Assert<AssertExactKeys<SDKTypes.ImageContent, SpecTypes.ImageContent>>;
type _K_AudioContent = Assert<AssertExactKeys<SDKTypes.AudioContent, SpecTypes.AudioContent>>;
type _K_EmbeddedResource = Assert<AssertExactKeys<SDKTypes.EmbeddedResource, SpecTypes.EmbeddedResource>>;
type _K_ResourceLink = Assert<AssertExactKeys<SDKTypes.ResourceLink, SpecTypes.ResourceLink>>;
type _K_PromptMessage = Assert<AssertExactKeys<SDKTypes.PromptMessage, SpecTypes.PromptMessage>>;
type _K_BooleanSchema = Assert<AssertExactKeys<SDKTypes.BooleanSchema, SpecTypes.BooleanSchema>>;
type _K_StringSchema = Assert<AssertExactKeys<SDKTypes.StringSchema, SpecTypes.StringSchema>>;
type _K_NumberSchema = Assert<AssertExactKeys<SDKTypes.NumberSchema, SpecTypes.NumberSchema>>;
type _K_UntitledSingleSelectEnumSchema = Assert<
    AssertExactKeys<SDKTypes.UntitledSingleSelectEnumSchema, SpecTypes.UntitledSingleSelectEnumSchema>
>;
type _K_TitledSingleSelectEnumSchema = Assert<
    AssertExactKeys<SDKTypes.TitledSingleSelectEnumSchema, SpecTypes.TitledSingleSelectEnumSchema>
>;
type _K_UntitledMultiSelectEnumSchema = Assert<
    AssertExactKeys<SDKTypes.UntitledMultiSelectEnumSchema, SpecTypes.UntitledMultiSelectEnumSchema>
>;
type _K_TitledMultiSelectEnumSchema = Assert<AssertExactKeys<SDKTypes.TitledMultiSelectEnumSchema, SpecTypes.TitledMultiSelectEnumSchema>>;
type _K_LegacyTitledEnumSchema = Assert<AssertExactKeys<SDKTypes.LegacyTitledEnumSchema, SpecTypes.LegacyTitledEnumSchema>>;
type _K_JSONRPCErrorResponse = Assert<AssertExactKeys<SDKTypes.JSONRPCErrorResponse, SpecTypes.JSONRPCErrorResponse>>;
type _K_JSONRPCResultResponse = Assert<AssertExactKeys<SDKTypes.JSONRPCResultResponse, SpecTypes.JSONRPCResultResponse>>;
type _K_InitializeResult = Assert<AssertExactKeys<SDKTypes.InitializeResult, SpecTypes.InitializeResult>>;
type _K_ClientCapabilities = Assert<AssertExactKeys<SDKTypes.ClientCapabilities, SpecTypes.ClientCapabilities>>;
type _K_ServerCapabilities = Assert<AssertExactKeys<SDKTypes.ServerCapabilities, SpecTypes.ServerCapabilities>>;
type _K_SamplingMessage = Assert<AssertExactKeys<SDKTypes.SamplingMessage, SpecTypes.SamplingMessage>>;
type _K_Icon = Assert<AssertExactKeys<SDKTypes.Icon, SpecTypes.Icon>>;
type _K_Icons = Assert<AssertExactKeys<SDKTypes.Icons, SpecTypes.Icons>>;
type _K_ModelHint = Assert<AssertExactKeys<SDKTypes.ModelHint, SpecTypes.ModelHint>>;
type _K_ModelPreferences = Assert<AssertExactKeys<SDKTypes.ModelPreferences, SpecTypes.ModelPreferences>>;
type _K_ToolChoice = Assert<AssertExactKeys<SDKTypes.ToolChoice, SpecTypes.ToolChoice>>;
type _K_ToolUseContent = Assert<AssertExactKeys<SDKTypes.ToolUseContent, SpecTypes.ToolUseContent>>;
type _K_ToolResultContent = Assert<AssertExactKeys<SDKTypes.ToolResultContent, SpecTypes.ToolResultContent>>;
type _K_Annotations = Assert<AssertExactKeys<SDKTypes.Annotations, SpecTypes.Annotations>>;
type _K_TaskAugmentedRequestParams = Assert<AssertExactKeys<SDKTypes.TaskAugmentedRequestParams, SpecTypes.TaskAugmentedRequestParams>>;
type _K_ToolExecution = Assert<AssertExactKeys<SDKTypes.ToolExecution, SpecTypes.ToolExecution>>;
type _K_TaskMetadata = Assert<AssertExactKeys<SDKTypes.TaskMetadata, SpecTypes.TaskMetadata>>;
type _K_RelatedTaskMetadata = Assert<AssertExactKeys<SDKTypes.RelatedTaskMetadata, SpecTypes.RelatedTaskMetadata>>;
type _K_Task = Assert<AssertExactKeys<SDKTypes.Task, SpecTypes.Task>>;
type _K_CreateTaskResult = Assert<AssertExactKeys<SDKTypes.CreateTaskResult, SpecTypes.CreateTaskResult>>;
type _K_GetTaskResult = Assert<AssertExactKeys<SDKTypes.GetTaskResult, SpecTypes.GetTaskResult>>;
type _K_ListTasksResult = Assert<AssertExactKeys<SDKTypes.ListTasksResult, SpecTypes.ListTasksResult>>;
type _K_CancelTaskResult = Assert<AssertExactKeys<SDKTypes.CancelTaskResult, SpecTypes.CancelTaskResult>>;
type _K_GetTaskPayloadResult = Assert<AssertExactKeys<SDKTypes.GetTaskPayloadResult, SpecTypes.GetTaskPayloadResult>>;
type _K_TaskStatusNotificationParams = Assert<
    AssertExactKeys<SDKTypes.TaskStatusNotificationParams, SpecTypes.TaskStatusNotificationParams>
>;
type _K_JSONObject = Assert<AssertExactKeys<SDKTypes.JSONObject, SpecTypes.JSONObject>>;
type _K_MetaObject = Assert<AssertExactKeys<SDKTypes.MetaObject, SpecTypes.MetaObject>>;
// @ts-expect-error Genuine mismatch: SDK RequestMetaObject has extra 'io.modelcontextprotocol/related-task' not in spec
type _K_RequestMetaObject = Assert<AssertExactKeys<SDKTypes.RequestMetaObject, SpecTypes.RequestMetaObject>>;
type _K_ParseError = Assert<AssertExactKeys<SDKTypes.ParseError, SpecTypes.ParseError>>;
type _K_InvalidRequestError = Assert<AssertExactKeys<SDKTypes.InvalidRequestError, SpecTypes.InvalidRequestError>>;
type _K_MethodNotFoundError = Assert<AssertExactKeys<SDKTypes.MethodNotFoundError, SpecTypes.MethodNotFoundError>>;
type _K_InvalidParamsError = Assert<AssertExactKeys<SDKTypes.InvalidParamsError, SpecTypes.InvalidParamsError>>;
type _K_InternalError = Assert<AssertExactKeys<SDKTypes.InternalError, SpecTypes.InternalError>>;

// -- WithJSONRPC-wrapped notification types (11) --
// SDK notification types do not include `jsonrpc` — the spec types do. We wrap
// with WithJSONRPC<> to add the missing field before comparing keys.

type _K_ElicitationCompleteNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.ElicitationCompleteNotification>, SpecTypes.ElicitationCompleteNotification>
>;
type _K_CancelledNotification = Assert<AssertExactKeys<WithJSONRPC<SDKTypes.CancelledNotification>, SpecTypes.CancelledNotification>>;
type _K_ProgressNotification = Assert<AssertExactKeys<WithJSONRPC<SDKTypes.ProgressNotification>, SpecTypes.ProgressNotification>>;
type _K_ToolListChangedNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.ToolListChangedNotification>, SpecTypes.ToolListChangedNotification>
>;
type _K_ResourceListChangedNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.ResourceListChangedNotification>, SpecTypes.ResourceListChangedNotification>
>;
type _K_PromptListChangedNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.PromptListChangedNotification>, SpecTypes.PromptListChangedNotification>
>;
type _K_RootsListChangedNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.RootsListChangedNotification>, SpecTypes.RootsListChangedNotification>
>;
type _K_ResourceUpdatedNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.ResourceUpdatedNotification>, SpecTypes.ResourceUpdatedNotification>
>;
type _K_LoggingMessageNotification = Assert<
    AssertExactKeys<WithJSONRPC<SDKTypes.LoggingMessageNotification>, SpecTypes.LoggingMessageNotification>
>;
type _K_InitializedNotification = Assert<AssertExactKeys<WithJSONRPC<SDKTypes.InitializedNotification>, SpecTypes.InitializedNotification>>;
type _K_TaskStatusNotification = Assert<AssertExactKeys<WithJSONRPC<SDKTypes.TaskStatusNotification>, SpecTypes.TaskStatusNotification>>;

// -- WithJSONRPCRequest-wrapped request types (21) --
// SDK request types do not include `jsonrpc` or `id` — the spec types do. We
// wrap with WithJSONRPCRequest<> to add the missing fields before comparing keys.

type _K_SubscribeRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.SubscribeRequest>, SpecTypes.SubscribeRequest>>;
type _K_UnsubscribeRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.UnsubscribeRequest>, SpecTypes.UnsubscribeRequest>>;
type _K_PaginatedRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.PaginatedRequest>, SpecTypes.PaginatedRequest>>;
type _K_ListRootsRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ListRootsRequest>, SpecTypes.ListRootsRequest>>;
type _K_ElicitRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ElicitRequest>, SpecTypes.ElicitRequest>>;
type _K_CompleteRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.CompleteRequest>, SpecTypes.CompleteRequest>>;
type _K_ListToolsRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ListToolsRequest>, SpecTypes.ListToolsRequest>>;
type _K_CallToolRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.CallToolRequest>, SpecTypes.CallToolRequest>>;
type _K_SetLevelRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.SetLevelRequest>, SpecTypes.SetLevelRequest>>;
type _K_PingRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.PingRequest>, SpecTypes.PingRequest>>;
type _K_ListResourcesRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ListResourcesRequest>, SpecTypes.ListResourcesRequest>>;
type _K_ListResourceTemplatesRequest = Assert<
    AssertExactKeys<WithJSONRPCRequest<SDKTypes.ListResourceTemplatesRequest>, SpecTypes.ListResourceTemplatesRequest>
>;
type _K_ReadResourceRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ReadResourceRequest>, SpecTypes.ReadResourceRequest>>;
type _K_ListPromptsRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ListPromptsRequest>, SpecTypes.ListPromptsRequest>>;
type _K_GetPromptRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.GetPromptRequest>, SpecTypes.GetPromptRequest>>;
type _K_CreateMessageRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.CreateMessageRequest>, SpecTypes.CreateMessageRequest>>;
type _K_InitializeRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.InitializeRequest>, SpecTypes.InitializeRequest>>;
type _K_GetTaskPayloadRequest = Assert<
    AssertExactKeys<WithJSONRPCRequest<SDKTypes.GetTaskPayloadRequest>, SpecTypes.GetTaskPayloadRequest>
>;
type _K_ListTasksRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.ListTasksRequest>, SpecTypes.ListTasksRequest>>;
type _K_CancelTaskRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.CancelTaskRequest>, SpecTypes.CancelTaskRequest>>;
type _K_GetTaskRequest = Assert<AssertExactKeys<WithJSONRPCRequest<SDKTypes.GetTaskRequest>, SpecTypes.GetTaskRequest>>;

// -- TypedResultResponse-wrapped types (21) --
// The spec defines typed *ResultResponse interfaces that pair JSONRPCResultResponse
// with a specific result. We compare TypedResultResponse<SDKInnerType> against the
// spec's combined type.

type _K_InitializeResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.InitializeResult>, SpecTypes.InitializeResultResponse>
>;
type _K_PingResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.EmptyResult>, SpecTypes.PingResultResponse>>;
type _K_ListResourcesResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.ListResourcesResult>, SpecTypes.ListResourcesResultResponse>
>;
type _K_ListResourceTemplatesResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.ListResourceTemplatesResult>, SpecTypes.ListResourceTemplatesResultResponse>
>;
type _K_ReadResourceResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.ReadResourceResult>, SpecTypes.ReadResourceResultResponse>
>;
type _K_SubscribeResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.EmptyResult>, SpecTypes.SubscribeResultResponse>>;
type _K_UnsubscribeResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.EmptyResult>, SpecTypes.UnsubscribeResultResponse>>;
type _K_ListPromptsResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.ListPromptsResult>, SpecTypes.ListPromptsResultResponse>
>;
type _K_GetPromptResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.GetPromptResult>, SpecTypes.GetPromptResultResponse>>;
type _K_ListToolsResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.ListToolsResult>, SpecTypes.ListToolsResultResponse>>;
type _K_CallToolResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.CallToolResult>, SpecTypes.CallToolResultResponse>>;
type _K_CreateTaskResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.CreateTaskResult>, SpecTypes.CreateTaskResultResponse>
>;
type _K_GetTaskResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.GetTaskResult>, SpecTypes.GetTaskResultResponse>>;
type _K_GetTaskPayloadResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.GetTaskPayloadResult>, SpecTypes.GetTaskPayloadResultResponse>
>;
type _K_CancelTaskResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.CancelTaskResult>, SpecTypes.CancelTaskResultResponse>
>;
type _K_ListTasksResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.ListTasksResult>, SpecTypes.ListTasksResultResponse>>;
type _K_SetLevelResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.EmptyResult>, SpecTypes.SetLevelResultResponse>>;
type _K_CreateMessageResultResponse = Assert<
    AssertExactKeys<TypedResultResponse<SDKTypes.CreateMessageResultWithTools>, SpecTypes.CreateMessageResultResponse>
>;
type _K_CompleteResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.CompleteResult>, SpecTypes.CompleteResultResponse>>;
type _K_ListRootsResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.ListRootsResult>, SpecTypes.ListRootsResultResponse>>;
type _K_ElicitResultResponse = Assert<AssertExactKeys<TypedResultResponse<SDKTypes.ElicitResult>, SpecTypes.ElicitResultResponse>>;

// -- Name mismatches (2) --
// SDK exports these under different names than the spec.

type _K_CreateMessageResult = Assert<AssertExactKeys<SDKTypes.CreateMessageResultWithTools, SpecTypes.CreateMessageResult>>;
type _K_ResourceTemplate = Assert<AssertExactKeys<SDKTypes.ResourceTemplateType, SpecTypes.ResourceTemplate>>;

// Types excluded from the key-parity completeness guard: union types and primitive aliases
// that cannot have meaningful AssertExactKeys assertions.
const KEY_PARITY_EXCLUDED = [
    // Union types (15)
    'ClientRequest',
    'ServerRequest',
    'ClientNotification',
    'ServerNotification',
    'ClientResult',
    'ServerResult',
    'JSONRPCMessage',
    'JSONRPCResponse',
    'ContentBlock',
    'SamplingMessageContentBlock',
    'ElicitRequestParams',
    'PrimitiveSchemaDefinition',
    'SingleSelectEnumSchema',
    'MultiSelectEnumSchema',
    'EnumSchema',
    // Primitive aliases (8)
    'JSONValue',
    'JSONArray',
    'Role',
    'LoggingLevel',
    'ProgressToken',
    'RequestId',
    'Cursor',
    'TaskStatus'
];

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE = path.resolve(__dirname, '../src/types/spec.types.ts');
const SDK_TYPES_FILE = path.resolve(__dirname, '../src/types/types.ts');

const MISSING_SDK_TYPES = [
    // These are inlined in the SDK:
    'Error', // The inner error object of a JSONRPCError
    'URLElicitationRequiredError' // In the SDK, but with a custom definition
];

function extractExportedTypes(source: string): string[] {
    const matches = [...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g)];
    return matches.map(m => m[1]!);
}

function extractKeyParityTypes(source: string): string[] {
    return [...source.matchAll(/^type _K_(\w+)\s*=/gm)].map(m => m[1]!);
}

describe('Spec Types', () => {
    const specTypes = extractExportedTypes(fs.readFileSync(SPEC_TYPES_FILE, 'utf8'));
    const sdkTypes = extractExportedTypes(fs.readFileSync(SDK_TYPES_FILE, 'utf8'));
    const typesToCheck = specTypes.filter(type => !MISSING_SDK_TYPES.includes(type));

    it('should define some expected types', () => {
        expect(specTypes).toContain('JSONRPCNotification');
        expect(specTypes).toContain('ElicitResult');
        expect(specTypes).toHaveLength(176);
    });

    it('should have up to date list of missing sdk types', () => {
        for (const typeName of MISSING_SDK_TYPES) {
            expect(sdkTypes).not.toContain(typeName);
        }
    });

    it('should have comprehensive compatibility tests', () => {
        const missingTests = [];

        for (const typeName of typesToCheck) {
            if (!sdkTypeChecks[typeName as keyof typeof sdkTypeChecks]) {
                missingTests.push(typeName);
            }
        }

        expect(missingTests).toHaveLength(0);
    });

    it('should have key-parity assertions for all non-excluded compatibility tests', () => {
        const thisSource = fs.readFileSync(__filename, 'utf8');
        const checked = new Set(extractKeyParityTypes(thisSource));
        const excluded = new Set<string>(KEY_PARITY_EXCLUDED);
        const missing = Object.keys(sdkTypeChecks).filter(name => !checked.has(name) && !excluded.has(name));
        expect(missing).toHaveLength(0);
    });

    describe('Missing SDK Types', () => {
        it.each(MISSING_SDK_TYPES)('%s should not be present in MISSING_SDK_TYPES if it has a compatibility test', type => {
            expect(sdkTypeChecks[type as keyof typeof sdkTypeChecks]).toBeUndefined();
        });
    });
});
