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

/**
 * Recursively adds `| undefined` to all optional properties in a type.
 *
 * Zod v4 infers `field?: T | undefined` for `.optional()` while the upstream spec
 * type generator emits `field?: T`. Under `exactOptionalPropertyTypes` these are
 * not bidirectionally assignable. The distinction is meaningless for JSON-deserialized
 * data (JSON has no `undefined`), so this utility bridges the gap without requiring
 * upstream changes to spec.types.ts.
 *
 * Note: this slightly relaxes the spec side of the bidirectional check — if the spec
 * ever tightened an optional field to required, this wrapper could mask that change.
 */
type DeepAddUndefinedToOptionals<T> =
    T extends (infer U)[]
        ? DeepAddUndefinedToOptionals<U>[]
        : T extends object
          ? { [K in keyof T]: string extends K
                ? T[K] // preserve index signature values unchanged
                : undefined extends T[K]
                  ? DeepAddUndefinedToOptionals<Exclude<T[K], undefined>> | undefined
                  : DeepAddUndefinedToOptionals<T[K]> }
          : T;

// Shorthand alias for wrapping spec types in the bidirectional checks below.
type Spec<T> = DeepAddUndefinedToOptionals<T>;

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
    RequestParams: (sdk: SDKTypes.RequestParams, spec: Spec<SpecTypes.RequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    NotificationParams: (sdk: SDKTypes.NotificationParams, spec: Spec<SpecTypes.NotificationParams>) => {
        sdk = spec;
        spec = sdk;
    },
    CancelledNotificationParams: (sdk: SDKTypes.CancelledNotificationParams, spec: Spec<SpecTypes.CancelledNotificationParams>) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeRequestParams: (sdk: SDKTypes.InitializeRequestParams, spec: Spec<SpecTypes.InitializeRequestParams>) => {
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; index sig mismatch under exactOptionalPropertyTypes
        sdk = spec;
        spec = sdk;
    },
    ProgressNotificationParams: (sdk: SDKTypes.ProgressNotificationParams, spec: Spec<SpecTypes.ProgressNotificationParams>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceRequestParams: (sdk: SDKTypes.ResourceRequestParams, spec: Spec<SpecTypes.ResourceRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceRequestParams: (sdk: SDKTypes.ReadResourceRequestParams, spec: Spec<SpecTypes.ReadResourceRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeRequestParams: (sdk: SDKTypes.SubscribeRequestParams, spec: Spec<SpecTypes.SubscribeRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeRequestParams: (sdk: SDKTypes.UnsubscribeRequestParams, spec: Spec<SpecTypes.UnsubscribeRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceUpdatedNotificationParams: (
        sdk: SDKTypes.ResourceUpdatedNotificationParams,
        spec: Spec<SpecTypes.ResourceUpdatedNotificationParams>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptRequestParams: (sdk: SDKTypes.GetPromptRequestParams, spec: Spec<SpecTypes.GetPromptRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolRequestParams: (sdk: SDKTypes.CallToolRequestParams, spec: Spec<SpecTypes.CallToolRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelRequestParams: (sdk: SDKTypes.SetLevelRequestParams, spec: Spec<SpecTypes.SetLevelRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingMessageNotificationParams: (
        sdk: SDKTypes.LoggingMessageNotificationParams,
        spec: Spec<SpecTypes.LoggingMessageNotificationParams>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageRequestParams: (sdk: SDKTypes.CreateMessageRequestParams, spec: Spec<SpecTypes.CreateMessageRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequestParams: (sdk: SDKTypes.CompleteRequestParams, spec: Spec<SpecTypes.CompleteRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequestParams: (sdk: SDKTypes.ElicitRequestParams, spec: Spec<SpecTypes.ElicitRequestParams>) => {
        sdk = spec;
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; Zod intersection mismatch under exactOptionalPropertyTypes
        spec = sdk;
    },
    ElicitRequestFormParams: (sdk: SDKTypes.ElicitRequestFormParams, spec: Spec<SpecTypes.ElicitRequestFormParams>) => {
        sdk = spec;
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; Zod intersection mismatch under exactOptionalPropertyTypes
        spec = sdk;
    },
    ElicitRequestURLParams: (sdk: SDKTypes.ElicitRequestURLParams, spec: Spec<SpecTypes.ElicitRequestURLParams>) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitationCompleteNotification: (
        sdk: WithJSONRPC<SDKTypes.ElicitationCompleteNotification>,
        spec: Spec<SpecTypes.ElicitationCompleteNotification>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequestParams: (sdk: SDKTypes.PaginatedRequestParams, spec: Spec<SpecTypes.PaginatedRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    CancelledNotification: (sdk: WithJSONRPC<SDKTypes.CancelledNotification>, spec: Spec<SpecTypes.CancelledNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    BaseMetadata: (sdk: SDKTypes.BaseMetadata, spec: Spec<SpecTypes.BaseMetadata>) => {
        sdk = spec;
        spec = sdk;
    },
    Implementation: (sdk: SDKTypes.Implementation, spec: Spec<SpecTypes.Implementation>) => {
        sdk = spec;
        spec = sdk;
    },
    ProgressNotification: (sdk: WithJSONRPC<SDKTypes.ProgressNotification>, spec: Spec<SpecTypes.ProgressNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeRequest: (sdk: WithJSONRPCRequest<SDKTypes.SubscribeRequest>, spec: Spec<SpecTypes.SubscribeRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeRequest: (sdk: WithJSONRPCRequest<SDKTypes.UnsubscribeRequest>, spec: Spec<SpecTypes.UnsubscribeRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequest: (sdk: WithJSONRPCRequest<SDKTypes.PaginatedRequest>, spec: Spec<SpecTypes.PaginatedRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedResult: (sdk: SDKTypes.PaginatedResult, spec: Spec<SpecTypes.PaginatedResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListRootsRequest>, spec: Spec<SpecTypes.ListRootsRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsResult: (sdk: SDKTypes.ListRootsResult, spec: Spec<SpecTypes.ListRootsResult>) => {
        sdk = spec;
        spec = sdk;
    },
    Root: (sdk: SDKTypes.Root, spec: Spec<SpecTypes.Root>) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequest: (sdk: WithJSONRPCRequest<SDKTypes.ElicitRequest>, spec: Spec<SpecTypes.ElicitRequest>) => {
        sdk = spec;
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; Zod intersection mismatch under exactOptionalPropertyTypes
        spec = sdk;
    },
    ElicitResult: (sdk: SDKTypes.ElicitResult, spec: Spec<SpecTypes.ElicitResult>) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequest: (sdk: WithJSONRPCRequest<SDKTypes.CompleteRequest>, spec: Spec<SpecTypes.CompleteRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteResult: (sdk: SDKTypes.CompleteResult, spec: Spec<SpecTypes.CompleteResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ProgressToken: (sdk: SDKTypes.ProgressToken, spec: Spec<SpecTypes.ProgressToken>) => {
        sdk = spec;
        spec = sdk;
    },
    Cursor: (sdk: SDKTypes.Cursor, spec: Spec<SpecTypes.Cursor>) => {
        sdk = spec;
        spec = sdk;
    },
    Request: (sdk: SDKTypes.Request, spec: Spec<SpecTypes.Request>) => {
        sdk = spec;
        spec = sdk;
    },
    Result: (sdk: SDKTypes.Result, spec: Spec<SpecTypes.Result>) => {
        sdk = spec;
        spec = sdk;
    },
    RequestId: (sdk: SDKTypes.RequestId, spec: Spec<SpecTypes.RequestId>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCRequest: (sdk: SDKTypes.JSONRPCRequest, spec: Spec<SpecTypes.JSONRPCRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCNotification: (sdk: SDKTypes.JSONRPCNotification, spec: Spec<SpecTypes.JSONRPCNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCResponse: (sdk: SDKTypes.JSONRPCResponse, spec: Spec<SpecTypes.JSONRPCResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    EmptyResult: (sdk: SDKTypes.EmptyResult, spec: Spec<SpecTypes.EmptyResult>) => {
        sdk = spec;
        spec = sdk;
    },
    Notification: (sdk: SDKTypes.Notification, spec: Spec<SpecTypes.Notification>) => {
        sdk = spec;
        spec = sdk;
    },
    ClientResult: (sdk: SDKTypes.ClientResult, spec: Spec<SpecTypes.ClientResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ClientNotification: (sdk: WithJSONRPC<SDKTypes.ClientNotification>, spec: Spec<SpecTypes.ClientNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    ServerResult: (sdk: SDKTypes.ServerResult, spec: Spec<SpecTypes.ServerResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceTemplateReference: (sdk: SDKTypes.ResourceTemplateReference, spec: Spec<SpecTypes.ResourceTemplateReference>) => {
        sdk = spec;
        spec = sdk;
    },
    PromptReference: (sdk: SDKTypes.PromptReference, spec: Spec<SpecTypes.PromptReference>) => {
        sdk = spec;
        spec = sdk;
    },
    ToolAnnotations: (sdk: SDKTypes.ToolAnnotations, spec: Spec<SpecTypes.ToolAnnotations>) => {
        sdk = spec;
        spec = sdk;
    },
    Tool: (sdk: SDKTypes.Tool, spec: Spec<SpecTypes.Tool>) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListToolsRequest>, spec: Spec<SpecTypes.ListToolsRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResult: (sdk: SDKTypes.ListToolsResult, spec: Spec<SpecTypes.ListToolsResult>) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolResult: (sdk: SDKTypes.CallToolResult, spec: Spec<SpecTypes.CallToolResult>) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolRequest: (sdk: WithJSONRPCRequest<SDKTypes.CallToolRequest>, spec: Spec<SpecTypes.CallToolRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ToolListChangedNotification: (sdk: WithJSONRPC<SDKTypes.ToolListChangedNotification>, spec: Spec<SpecTypes.ToolListChangedNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceListChangedNotification: (
        sdk: WithJSONRPC<SDKTypes.ResourceListChangedNotification>,
        spec: Spec<SpecTypes.ResourceListChangedNotification>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    PromptListChangedNotification: (
        sdk: WithJSONRPC<SDKTypes.PromptListChangedNotification>,
        spec: Spec<SpecTypes.PromptListChangedNotification>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    RootsListChangedNotification: (
        sdk: WithJSONRPC<SDKTypes.RootsListChangedNotification>,
        spec: Spec<SpecTypes.RootsListChangedNotification>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceUpdatedNotification: (sdk: WithJSONRPC<SDKTypes.ResourceUpdatedNotification>, spec: Spec<SpecTypes.ResourceUpdatedNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessage: (sdk: SDKTypes.SamplingMessage, spec: Spec<SpecTypes.SamplingMessage>) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageResult: (sdk: SDKTypes.CreateMessageResultWithTools, spec: Spec<SpecTypes.CreateMessageResult>) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelRequest: (sdk: WithJSONRPCRequest<SDKTypes.SetLevelRequest>, spec: Spec<SpecTypes.SetLevelRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    PingRequest: (sdk: WithJSONRPCRequest<SDKTypes.PingRequest>, spec: Spec<SpecTypes.PingRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    InitializedNotification: (sdk: WithJSONRPC<SDKTypes.InitializedNotification>, spec: Spec<SpecTypes.InitializedNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListResourcesRequest>, spec: Spec<SpecTypes.ListResourcesRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResult: (sdk: SDKTypes.ListResourcesResult, spec: Spec<SpecTypes.ListResourcesResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesRequest: (
        sdk: WithJSONRPCRequest<SDKTypes.ListResourceTemplatesRequest>,
        spec: Spec<SpecTypes.ListResourceTemplatesRequest>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResult: (sdk: SDKTypes.ListResourceTemplatesResult, spec: Spec<SpecTypes.ListResourceTemplatesResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceRequest: (sdk: WithJSONRPCRequest<SDKTypes.ReadResourceRequest>, spec: Spec<SpecTypes.ReadResourceRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceResult: (sdk: SDKTypes.ReadResourceResult, spec: Spec<SpecTypes.ReadResourceResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceContents: (sdk: SDKTypes.ResourceContents, spec: Spec<SpecTypes.ResourceContents>) => {
        sdk = spec;
        spec = sdk;
    },
    TextResourceContents: (sdk: SDKTypes.TextResourceContents, spec: Spec<SpecTypes.TextResourceContents>) => {
        sdk = spec;
        spec = sdk;
    },
    BlobResourceContents: (sdk: SDKTypes.BlobResourceContents, spec: Spec<SpecTypes.BlobResourceContents>) => {
        sdk = spec;
        spec = sdk;
    },
    Resource: (sdk: SDKTypes.Resource, spec: Spec<SpecTypes.Resource>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceTemplate: (sdk: SDKTypes.ResourceTemplateType, spec: Spec<SpecTypes.ResourceTemplate>) => {
        sdk = spec;
        spec = sdk;
    },
    PromptArgument: (sdk: SDKTypes.PromptArgument, spec: Spec<SpecTypes.PromptArgument>) => {
        sdk = spec;
        spec = sdk;
    },
    Prompt: (sdk: SDKTypes.Prompt, spec: Spec<SpecTypes.Prompt>) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListPromptsRequest>, spec: Spec<SpecTypes.ListPromptsRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResult: (sdk: SDKTypes.ListPromptsResult, spec: Spec<SpecTypes.ListPromptsResult>) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetPromptRequest>, spec: Spec<SpecTypes.GetPromptRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    TextContent: (sdk: SDKTypes.TextContent, spec: Spec<SpecTypes.TextContent>) => {
        sdk = spec;
        spec = sdk;
    },
    ImageContent: (sdk: SDKTypes.ImageContent, spec: Spec<SpecTypes.ImageContent>) => {
        sdk = spec;
        spec = sdk;
    },
    AudioContent: (sdk: SDKTypes.AudioContent, spec: Spec<SpecTypes.AudioContent>) => {
        sdk = spec;
        spec = sdk;
    },
    EmbeddedResource: (sdk: SDKTypes.EmbeddedResource, spec: Spec<SpecTypes.EmbeddedResource>) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceLink: (sdk: SDKTypes.ResourceLink, spec: Spec<SpecTypes.ResourceLink>) => {
        sdk = spec;
        spec = sdk;
    },
    ContentBlock: (sdk: SDKTypes.ContentBlock, spec: Spec<SpecTypes.ContentBlock>) => {
        sdk = spec;
        spec = sdk;
    },
    PromptMessage: (sdk: SDKTypes.PromptMessage, spec: Spec<SpecTypes.PromptMessage>) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptResult: (sdk: SDKTypes.GetPromptResult, spec: Spec<SpecTypes.GetPromptResult>) => {
        sdk = spec;
        spec = sdk;
    },
    BooleanSchema: (sdk: SDKTypes.BooleanSchema, spec: Spec<SpecTypes.BooleanSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    StringSchema: (sdk: SDKTypes.StringSchema, spec: Spec<SpecTypes.StringSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    NumberSchema: (sdk: SDKTypes.NumberSchema, spec: Spec<SpecTypes.NumberSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    EnumSchema: (sdk: SDKTypes.EnumSchema, spec: Spec<SpecTypes.EnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    UntitledSingleSelectEnumSchema: (sdk: SDKTypes.UntitledSingleSelectEnumSchema, spec: Spec<SpecTypes.UntitledSingleSelectEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    TitledSingleSelectEnumSchema: (sdk: SDKTypes.TitledSingleSelectEnumSchema, spec: Spec<SpecTypes.TitledSingleSelectEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    SingleSelectEnumSchema: (sdk: SDKTypes.SingleSelectEnumSchema, spec: Spec<SpecTypes.SingleSelectEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    UntitledMultiSelectEnumSchema: (sdk: SDKTypes.UntitledMultiSelectEnumSchema, spec: Spec<SpecTypes.UntitledMultiSelectEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    TitledMultiSelectEnumSchema: (sdk: SDKTypes.TitledMultiSelectEnumSchema, spec: Spec<SpecTypes.TitledMultiSelectEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    MultiSelectEnumSchema: (sdk: SDKTypes.MultiSelectEnumSchema, spec: Spec<SpecTypes.MultiSelectEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    LegacyTitledEnumSchema: (sdk: SDKTypes.LegacyTitledEnumSchema, spec: Spec<SpecTypes.LegacyTitledEnumSchema>) => {
        sdk = spec;
        spec = sdk;
    },
    PrimitiveSchemaDefinition: (sdk: SDKTypes.PrimitiveSchemaDefinition, spec: Spec<SpecTypes.PrimitiveSchemaDefinition>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCErrorResponse: (sdk: SDKTypes.JSONRPCErrorResponse, spec: Spec<SpecTypes.JSONRPCErrorResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCResultResponse: (sdk: SDKTypes.JSONRPCResultResponse, spec: Spec<SpecTypes.JSONRPCResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCMessage: (sdk: SDKTypes.JSONRPCMessage, spec: Spec<SpecTypes.JSONRPCMessage>) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageRequest: (sdk: WithJSONRPCRequest<SDKTypes.CreateMessageRequest>, spec: Spec<SpecTypes.CreateMessageRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeRequest: (sdk: WithJSONRPCRequest<SDKTypes.InitializeRequest>, spec: Spec<SpecTypes.InitializeRequest>) => {
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; index sig mismatch under exactOptionalPropertyTypes
        sdk = spec;
        spec = sdk;
    },
    InitializeResult: (sdk: SDKTypes.InitializeResult, spec: Spec<SpecTypes.InitializeResult>) => {
        sdk = spec;
        spec = sdk;
    },
    ClientCapabilities: (sdk: SDKTypes.ClientCapabilities, spec: Spec<SpecTypes.ClientCapabilities>) => {
        // @ts-expect-error: SDK expands JSONObject inline; Zod intersection mismatch under exactOptionalPropertyTypes
        sdk = spec;
        spec = sdk;
    },
    ServerCapabilities: (sdk: SDKTypes.ServerCapabilities, spec: Spec<SpecTypes.ServerCapabilities>) => {
        sdk = spec;
        spec = sdk;
    },
    ClientRequest: (sdk: WithJSONRPCRequest<SDKTypes.ClientRequest>, spec: Spec<SpecTypes.ClientRequest>) => {
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; index sig mismatch under exactOptionalPropertyTypes
        sdk = spec;
        spec = sdk;
    },
    ServerRequest: (sdk: WithJSONRPCRequest<SDKTypes.ServerRequest>, spec: Spec<SpecTypes.ServerRequest>) => {
        sdk = spec;
        // @ts-expect-error: SDK _meta adds "io.modelcontextprotocol/related-task" not in spec; index sig mismatch under exactOptionalPropertyTypes
        spec = sdk;
    },
    LoggingMessageNotification: (sdk: WithJSONRPC<SDKTypes.LoggingMessageNotification>, spec: Spec<SpecTypes.LoggingMessageNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    ServerNotification: (sdk: WithJSONRPC<SDKTypes.ServerNotification>, spec: Spec<SpecTypes.ServerNotification>) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingLevel: (sdk: SDKTypes.LoggingLevel, spec: Spec<SpecTypes.LoggingLevel>) => {
        sdk = spec;
        spec = sdk;
    },
    Icon: (sdk: SDKTypes.Icon, spec: Spec<SpecTypes.Icon>) => {
        sdk = spec;
        spec = sdk;
    },
    Icons: (sdk: SDKTypes.Icons, spec: Spec<SpecTypes.Icons>) => {
        sdk = spec;
        spec = sdk;
    },
    ModelHint: (sdk: SDKTypes.ModelHint, spec: Spec<SpecTypes.ModelHint>) => {
        sdk = spec;
        spec = sdk;
    },
    ModelPreferences: (sdk: SDKTypes.ModelPreferences, spec: Spec<SpecTypes.ModelPreferences>) => {
        sdk = spec;
        spec = sdk;
    },
    ToolChoice: (sdk: SDKTypes.ToolChoice, spec: Spec<SpecTypes.ToolChoice>) => {
        sdk = spec;
        spec = sdk;
    },
    ToolUseContent: (sdk: SDKTypes.ToolUseContent, spec: Spec<SpecTypes.ToolUseContent>) => {
        sdk = spec;
        spec = sdk;
    },
    ToolResultContent: (sdk: SDKTypes.ToolResultContent, spec: Spec<SpecTypes.ToolResultContent>) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessageContentBlock: (sdk: SDKTypes.SamplingMessageContentBlock, spec: Spec<SpecTypes.SamplingMessageContentBlock>) => {
        sdk = spec;
        spec = sdk;
    },
    Annotations: (sdk: SDKTypes.Annotations, spec: Spec<SpecTypes.Annotations>) => {
        sdk = spec;
        spec = sdk;
    },
    Role: (sdk: SDKTypes.Role, spec: Spec<SpecTypes.Role>) => {
        sdk = spec;
        spec = sdk;
    },
    TaskAugmentedRequestParams: (sdk: SDKTypes.TaskAugmentedRequestParams, spec: Spec<SpecTypes.TaskAugmentedRequestParams>) => {
        sdk = spec;
        spec = sdk;
    },
    ToolExecution: (sdk: SDKTypes.ToolExecution, spec: Spec<SpecTypes.ToolExecution>) => {
        sdk = spec;
        spec = sdk;
    },
    TaskStatus: (sdk: SDKTypes.TaskStatus, spec: Spec<SpecTypes.TaskStatus>) => {
        sdk = spec;
        spec = sdk;
    },
    TaskMetadata: (sdk: SDKTypes.TaskMetadata, spec: Spec<SpecTypes.TaskMetadata>) => {
        sdk = spec;
        spec = sdk;
    },
    RelatedTaskMetadata: (sdk: SDKTypes.RelatedTaskMetadata, spec: Spec<SpecTypes.RelatedTaskMetadata>) => {
        sdk = spec;
        spec = sdk;
    },
    Task: (sdk: SDKTypes.Task, spec: Spec<SpecTypes.Task>) => {
        sdk = spec;
        spec = sdk;
    },
    CreateTaskResult: (sdk: SDKTypes.CreateTaskResult, spec: Spec<SpecTypes.CreateTaskResult>) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskResult: (sdk: SDKTypes.GetTaskResult, spec: Spec<SpecTypes.GetTaskResult>) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskPayloadRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetTaskPayloadRequest>, spec: Spec<SpecTypes.GetTaskPayloadRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ListTasksRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListTasksRequest>, spec: Spec<SpecTypes.ListTasksRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    ListTasksResult: (sdk: SDKTypes.ListTasksResult, spec: Spec<SpecTypes.ListTasksResult>) => {
        sdk = spec;
        spec = sdk;
    },
    CancelTaskRequest: (sdk: WithJSONRPCRequest<SDKTypes.CancelTaskRequest>, spec: Spec<SpecTypes.CancelTaskRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    CancelTaskResult: (sdk: SDKTypes.CancelTaskResult, spec: Spec<SpecTypes.CancelTaskResult>) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetTaskRequest>, spec: Spec<SpecTypes.GetTaskRequest>) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskPayloadResult: (sdk: SDKTypes.GetTaskPayloadResult, spec: Spec<SpecTypes.GetTaskPayloadResult>) => {
        sdk = spec;
        spec = sdk;
    },
    TaskStatusNotificationParams: (sdk: SDKTypes.TaskStatusNotificationParams, spec: Spec<SpecTypes.TaskStatusNotificationParams>) => {
        sdk = spec;
        spec = sdk;
    },
    TaskStatusNotification: (sdk: WithJSONRPC<SDKTypes.TaskStatusNotification>, spec: Spec<SpecTypes.TaskStatusNotification>) => {
        sdk = spec;
        spec = sdk;
    },

    /* JSON primitives */
    JSONValue: (sdk: SDKTypes.JSONValue, spec: Spec<SpecTypes.JSONValue>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONObject: (sdk: SDKTypes.JSONObject, spec: Spec<SpecTypes.JSONObject>) => {
        sdk = spec;
        spec = sdk;
    },
    JSONArray: (sdk: SDKTypes.JSONArray, spec: Spec<SpecTypes.JSONArray>) => {
        sdk = spec;
        spec = sdk;
    },

    /* Meta types */
    MetaObject: (sdk: SDKTypes.MetaObject, spec: Spec<SpecTypes.MetaObject>) => {
        sdk = spec;
        spec = sdk;
    },
    RequestMetaObject: (sdk: SDKTypes.RequestMetaObject, spec: Spec<SpecTypes.RequestMetaObject>) => {
        sdk = spec;
        spec = sdk;
    },

    /* Error types */
    ParseError: (sdk: SDKTypes.ParseError, spec: Spec<SpecTypes.ParseError>) => {
        sdk = spec;
        spec = sdk;
    },
    InvalidRequestError: (sdk: SDKTypes.InvalidRequestError, spec: Spec<SpecTypes.InvalidRequestError>) => {
        sdk = spec;
        spec = sdk;
    },
    MethodNotFoundError: (sdk: SDKTypes.MethodNotFoundError, spec: Spec<SpecTypes.MethodNotFoundError>) => {
        sdk = spec;
        spec = sdk;
    },
    InvalidParamsError: (sdk: SDKTypes.InvalidParamsError, spec: Spec<SpecTypes.InvalidParamsError>) => {
        sdk = spec;
        spec = sdk;
    },
    InternalError: (sdk: SDKTypes.InternalError, spec: Spec<SpecTypes.InternalError>) => {
        sdk = spec;
        spec = sdk;
    },

    /* ResultResponse types — see TypedResultResponse comment above */
    InitializeResultResponse: (sdk: TypedResultResponse<SDKTypes.InitializeResult>, spec: Spec<SpecTypes.InitializeResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    PingResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: Spec<SpecTypes.PingResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResultResponse: (sdk: TypedResultResponse<SDKTypes.ListResourcesResult>, spec: Spec<SpecTypes.ListResourcesResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResultResponse: (
        sdk: TypedResultResponse<SDKTypes.ListResourceTemplatesResult>,
        spec: Spec<SpecTypes.ListResourceTemplatesResultResponse>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceResultResponse: (sdk: TypedResultResponse<SDKTypes.ReadResourceResult>, spec: Spec<SpecTypes.ReadResourceResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: Spec<SpecTypes.SubscribeResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: Spec<SpecTypes.UnsubscribeResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResultResponse: (sdk: TypedResultResponse<SDKTypes.ListPromptsResult>, spec: Spec<SpecTypes.ListPromptsResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptResultResponse: (sdk: TypedResultResponse<SDKTypes.GetPromptResult>, spec: Spec<SpecTypes.GetPromptResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResultResponse: (sdk: TypedResultResponse<SDKTypes.ListToolsResult>, spec: Spec<SpecTypes.ListToolsResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolResultResponse: (sdk: TypedResultResponse<SDKTypes.CallToolResult>, spec: Spec<SpecTypes.CallToolResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    CreateTaskResultResponse: (sdk: TypedResultResponse<SDKTypes.CreateTaskResult>, spec: Spec<SpecTypes.CreateTaskResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskResultResponse: (sdk: TypedResultResponse<SDKTypes.GetTaskResult>, spec: Spec<SpecTypes.GetTaskResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    GetTaskPayloadResultResponse: (
        sdk: TypedResultResponse<SDKTypes.GetTaskPayloadResult>,
        spec: Spec<SpecTypes.GetTaskPayloadResultResponse>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CancelTaskResultResponse: (sdk: TypedResultResponse<SDKTypes.CancelTaskResult>, spec: Spec<SpecTypes.CancelTaskResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ListTasksResultResponse: (sdk: TypedResultResponse<SDKTypes.ListTasksResult>, spec: Spec<SpecTypes.ListTasksResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelResultResponse: (sdk: TypedResultResponse<SDKTypes.EmptyResult>, spec: Spec<SpecTypes.SetLevelResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageResultResponse: (
        sdk: TypedResultResponse<SDKTypes.CreateMessageResultWithTools>,
        spec: Spec<SpecTypes.CreateMessageResultResponse>
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteResultResponse: (sdk: TypedResultResponse<SDKTypes.CompleteResult>, spec: Spec<SpecTypes.CompleteResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsResultResponse: (sdk: TypedResultResponse<SDKTypes.ListRootsResult>, spec: Spec<SpecTypes.ListRootsResultResponse>) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitResultResponse: (sdk: TypedResultResponse<SDKTypes.ElicitResult>, spec: Spec<SpecTypes.ElicitResultResponse>) => {
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
