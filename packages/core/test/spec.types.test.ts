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

    describe('Missing SDK Types', () => {
        it.each(MISSING_SDK_TYPES)('%s should not be present in MISSING_SDK_TYPES if it has a compatibility test', type => {
            expect(sdkTypeChecks[type as keyof typeof sdkTypeChecks]).toBeUndefined();
        });
    });
});
