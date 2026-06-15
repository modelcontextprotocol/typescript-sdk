/**
 * Per-revision parity: the 2026-era WIRE artifacts against the 2026-07-28
 * anchor (spec.types.2026-07-28.ts). The frozen-release comparison lives in
 * spec.types.2025-11-25.test.ts.
 *
 * Q1 increment 2 retired the old 67-name burn-down list (whose "permanent
 * stratum" could never burn under a single shared schema set): the SDK now
 * models era-specific wire shapes in `wire/rev2026-07-28/`, and everything
 * that module models is compared here EXACTLY — wire-true request views
 * (envelope-required `_meta`), resultType-required result wrappers, the
 * forked Tool/SamplingMessage payloads, response envelopes, and discover.
 *
 * What remains unmodeled lives in FEATURE_OWNED_PENDING_2026 below: every
 * entry is OWNED by a named feature issue and is stale-checked — adding a
 * check for a pending name forces the entry's removal, and the completeness
 * tests fail on any spec type that is neither checked nor owned. There is no
 * permanent stratum: when the owning features land, the list reaches zero.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    LATEST_PROTOCOL_VERSION,
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    UNSUPPORTED_PROTOCOL_VERSION
} from '../src/types/spec.types.2026-07-28.js';
import type * as SpecTypes from '../src/types/spec.types.2026-07-28.js';
import type * as SDKTypes from '../src/types/index.js';
import type * as Wire2026 from '../src/wire/rev2026-07-28/schemas.js';
import type * as z4 from 'zod/v4';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolErrorCode
} from '../src/types/index.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

// Adds the `jsonrpc` property to a type, to match the on-wire format of notifications.
type WithJSONRPC<T> = T & { jsonrpc: '2.0' };

// Adds the `jsonrpc` and `id` properties to a type, to match the on-wire format of requests.
type WithJSONRPCRequest<T> = T & { jsonrpc: '2.0'; id: SDKTypes.RequestId };

/* The 2026-era wire artifacts under comparison (inferred from the era module's
 * Zod schemas — the same objects the codec parses with). */
type WResult = z4.infer<typeof Wire2026.ResultSchema>;
type WResultType = z4.infer<typeof Wire2026.ResultTypeSchema>;
type WPaginatedResult = z4.infer<typeof Wire2026.PaginatedResultSchema>;
type WCacheableResult = z4.infer<typeof Wire2026.CacheableResultSchema>;
type WCallToolResult = z4.infer<typeof Wire2026.CallToolResultSchema>;
type WCompleteResult = z4.infer<typeof Wire2026.CompleteResultSchema>;
type WGetPromptResult = z4.infer<typeof Wire2026.GetPromptResultSchema>;
type WListPromptsResult = z4.infer<typeof Wire2026.ListPromptsResultSchema>;
type WListResourceTemplatesResult = z4.infer<typeof Wire2026.ListResourceTemplatesResultSchema>;
type WListResourcesResult = z4.infer<typeof Wire2026.ListResourcesResultSchema>;
type WListToolsResult = z4.infer<typeof Wire2026.ListToolsResultSchema>;
type WReadResourceResult = z4.infer<typeof Wire2026.ReadResourceResultSchema>;
type WDiscoverResult = z4.infer<typeof Wire2026.DiscoverResultSchema>;
type WTool = z4.infer<typeof Wire2026.ToolSchema>;
type WSamplingMessage = z4.infer<typeof Wire2026.SamplingMessageSchema>;
type WJSONRPCResultResponse = z4.infer<typeof Wire2026.JSONRPCResultResponseSchema>;
type WCompleteRequest = z4.infer<typeof Wire2026.CompleteRequestSchema>;
type WListPromptsRequest = z4.infer<typeof Wire2026.ListPromptsRequestSchema>;
type WListResourceTemplatesRequest = z4.infer<typeof Wire2026.ListResourceTemplatesRequestSchema>;
type WListResourcesRequest = z4.infer<typeof Wire2026.ListResourcesRequestSchema>;
type WListToolsRequest = z4.infer<typeof Wire2026.ListToolsRequestSchema>;
type WReadResourceRequest = z4.infer<typeof Wire2026.ReadResourceRequestSchema>;
type WDiscoverRequest = z4.infer<typeof Wire2026.DiscoverRequestSchema>;
// Param/base shapes derived from the request views (no second source of truth):
type WRequestParams = NonNullable<WDiscoverRequest['params']>;
type WPaginatedRequestParams = WListToolsRequest['params'];
type WResourceRequestParams = WReadResourceRequest['params'];
type WCompleteRequestParams = WCompleteRequest['params'];
// PaginatedRequest in the anchor keeps `method: string` (it is the base, not
// a concrete method) — composed from the derived params shape.
type WPaginatedRequest = WithJSONRPCRequest<{ method: string; params: WPaginatedRequestParams }>;

const sdkTypeChecks = {
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
    MetaObject: (sdk: SDKTypes.MetaObject, spec: SpecTypes.MetaObject) => {
        sdk = spec;
        spec = sdk;
    },
    // The SDK models the 2026-07-28 revision's required per-request `_meta` envelope as
    // RequestMetaEnvelope (the base request schemas stay lenient; envelope
    // requiredness is enforced at dispatch). This check also pins the
    // *_META_KEY constants: a drifted key name breaks mutual assignability.
    RequestMetaObject: (sdk: SDKTypes.RequestMetaEnvelope, spec: SpecTypes.RequestMetaObject) => {
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
    NotificationParams: (sdk: SDKTypes.NotificationParams, spec: SpecTypes.NotificationParams) => {
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
    JSONRPCNotification: (sdk: WithJSONRPC<SDKTypes.JSONRPCNotification>, spec: SpecTypes.JSONRPCNotification) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCErrorResponse: (sdk: SDKTypes.JSONRPCErrorResponse, spec: SpecTypes.JSONRPCErrorResponse) => {
        sdk = spec;
        spec = sdk;
    },
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
    CancelledNotificationParams: (sdk: SDKTypes.CancelledNotificationParams, spec: SpecTypes.CancelledNotificationParams) => {
        sdk = spec;
        spec = sdk;
    },
    CancelledNotification: (sdk: WithJSONRPC<SDKTypes.CancelledNotification>, spec: SpecTypes.CancelledNotification) => {
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
    Icon: (sdk: SDKTypes.Icon, spec: SpecTypes.Icon) => {
        sdk = spec;
        spec = sdk;
    },
    Icons: (sdk: SDKTypes.Icons, spec: SpecTypes.Icons) => {
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
    ProgressNotificationParams: (sdk: SDKTypes.ProgressNotificationParams, spec: SpecTypes.ProgressNotificationParams) => {
        sdk = spec;
        spec = sdk;
    },
    ProgressNotification: (sdk: WithJSONRPC<SDKTypes.ProgressNotification>, spec: SpecTypes.ProgressNotification) => {
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
    ResourceUpdatedNotificationParams: (
        sdk: SDKTypes.ResourceUpdatedNotificationParams,
        spec: SpecTypes.ResourceUpdatedNotificationParams
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceUpdatedNotification: (sdk: WithJSONRPC<SDKTypes.ResourceUpdatedNotification>, spec: SpecTypes.ResourceUpdatedNotification) => {
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
    Prompt: (sdk: SDKTypes.Prompt, spec: SpecTypes.Prompt) => {
        sdk = spec;
        spec = sdk;
    },
    PromptArgument: (sdk: SDKTypes.PromptArgument, spec: SpecTypes.PromptArgument) => {
        sdk = spec;
        spec = sdk;
    },
    Role: (sdk: SDKTypes.Role, spec: SpecTypes.Role) => {
        sdk = spec;
        spec = sdk;
    },
    PromptMessage: (sdk: SDKTypes.PromptMessage, spec: SpecTypes.PromptMessage) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceLink: (sdk: SDKTypes.ResourceLink, spec: SpecTypes.ResourceLink) => {
        sdk = spec;
        spec = sdk;
    },
    EmbeddedResource: (sdk: SDKTypes.EmbeddedResource, spec: SpecTypes.EmbeddedResource) => {
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
    ToolListChangedNotification: (sdk: WithJSONRPC<SDKTypes.ToolListChangedNotification>, spec: SpecTypes.ToolListChangedNotification) => {
        sdk = spec;
        spec = sdk;
    },
    ToolAnnotations: (sdk: SDKTypes.ToolAnnotations, spec: SpecTypes.ToolAnnotations) => {
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
    LoggingMessageNotification: (sdk: WithJSONRPC<SDKTypes.LoggingMessageNotification>, spec: SpecTypes.LoggingMessageNotification) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingLevel: (sdk: SDKTypes.LoggingLevel, spec: SpecTypes.LoggingLevel) => {
        sdk = spec;
        spec = sdk;
    },
    ToolChoice: (sdk: SDKTypes.ToolChoice, spec: SpecTypes.ToolChoice) => {
        sdk = spec;
        spec = sdk;
    },
    Annotations: (sdk: SDKTypes.Annotations, spec: SpecTypes.Annotations) => {
        sdk = spec;
        spec = sdk;
    },
    ContentBlock: (sdk: SDKTypes.ContentBlock, spec: SpecTypes.ContentBlock) => {
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
    ToolUseContent: (sdk: SDKTypes.ToolUseContent, spec: SpecTypes.ToolUseContent) => {
        sdk = spec;
        spec = sdk;
    },
    ModelPreferences: (sdk: SDKTypes.ModelPreferences, spec: SpecTypes.ModelPreferences) => {
        sdk = spec;
        spec = sdk;
    },
    ModelHint: (sdk: SDKTypes.ModelHint, spec: SpecTypes.ModelHint) => {
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
    Root: (sdk: SDKTypes.Root, spec: SpecTypes.Root) => {
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
    ElicitRequestParams: (sdk: SDKTypes.ElicitRequestParams, spec: SpecTypes.ElicitRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequest: (sdk: SDKTypes.ElicitRequest, spec: SpecTypes.ElicitRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PrimitiveSchemaDefinition: (sdk: SDKTypes.PrimitiveSchemaDefinition, spec: SpecTypes.PrimitiveSchemaDefinition) => {
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
    BooleanSchema: (sdk: SDKTypes.BooleanSchema, spec: SpecTypes.BooleanSchema) => {
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
    EnumSchema: (sdk: SDKTypes.EnumSchema, spec: SpecTypes.EnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitationCompleteNotificationParams: (
        sdk: SDKTypes.ElicitationCompleteNotificationParams,
        spec: SpecTypes.ElicitationCompleteNotificationParams
    ) => {
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
    ClientNotification: (sdk: WithJSONRPC<SDKTypes.ClientNotification>, spec: SpecTypes.ClientNotification) => {
        sdk = spec;
        spec = sdk;
    }
};

/* 2026-era wire parity checks (Q1 increment 2) — appended to sdkTypeChecks. */
const wireParityChecks = {
    Result: (sdk: WResult, spec: SpecTypes.Result) => {
        sdk = spec;
        spec = sdk;
    },
    ResultType: (sdk: WResultType, spec: SpecTypes.ResultType) => {
        sdk = spec;
        spec = sdk;
    },
    EmptyResult: (sdk: WResult, spec: SpecTypes.EmptyResult) => {
        sdk = spec;
        spec = sdk;
    },
    ClientResult: (sdk: WResult, spec: SpecTypes.ClientResult) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedResult: (sdk: WPaginatedResult, spec: SpecTypes.PaginatedResult) => {
        sdk = spec;
        spec = sdk;
    },
    CacheableResult: (sdk: WCacheableResult, spec: SpecTypes.CacheableResult) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolResult: (sdk: WCallToolResult, spec: SpecTypes.CallToolResult) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteResult: (sdk: WCompleteResult, spec: SpecTypes.CompleteResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptResult: (sdk: WGetPromptResult, spec: SpecTypes.GetPromptResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResult: (sdk: WListPromptsResult, spec: SpecTypes.ListPromptsResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResult: (sdk: WListResourceTemplatesResult, spec: SpecTypes.ListResourceTemplatesResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResult: (sdk: WListResourcesResult, spec: SpecTypes.ListResourcesResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResult: (sdk: WListToolsResult, spec: SpecTypes.ListToolsResult) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceResult: (sdk: WReadResourceResult, spec: SpecTypes.ReadResourceResult) => {
        sdk = spec;
        spec = sdk;
    },
    DiscoverResult: (sdk: WDiscoverResult, spec: SpecTypes.DiscoverResult) => {
        sdk = spec;
        spec = sdk;
    },
    DiscoverRequest: (sdk: WithJSONRPCRequest<WDiscoverRequest>, spec: SpecTypes.DiscoverRequest) => {
        sdk = spec;
        spec = sdk;
    },
    Tool: (sdk: WTool, spec: SpecTypes.Tool) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessage: (sdk: WSamplingMessage, spec: SpecTypes.SamplingMessage) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessageContentBlock: (
        sdk: z4.infer<typeof Wire2026.SamplingMessageContentBlockSchema>,
        spec: SpecTypes.SamplingMessageContentBlock
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ToolResultContent: (sdk: z4.infer<typeof Wire2026.ToolResultContentSchema>, spec: SpecTypes.ToolResultContent) => {
        sdk = spec;
        spec = sdk;
    },
    Notification: (sdk: SDKTypes.Notification, spec: SpecTypes.Notification) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCResultResponse: (sdk: WJSONRPCResultResponse, spec: SpecTypes.JSONRPCResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCResponse: (sdk: WJSONRPCResultResponse | SDKTypes.JSONRPCErrorResponse, spec: SpecTypes.JSONRPCResponse) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCMessage: (
        sdk: SDKTypes.JSONRPCRequest | WithJSONRPC<SDKTypes.JSONRPCNotification> | WJSONRPCResultResponse | SDKTypes.JSONRPCErrorResponse,
        spec: SpecTypes.JSONRPCMessage
    ) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteResultResponse: (sdk: z4.infer<typeof Wire2026.CompleteResultResponseSchema>, spec: SpecTypes.CompleteResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResultResponse: (
        sdk: z4.infer<typeof Wire2026.ListPromptsResultResponseSchema>,
        spec: SpecTypes.ListPromptsResultResponse
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResultResponse: (
        sdk: z4.infer<typeof Wire2026.ListResourceTemplatesResultResponseSchema>,
        spec: SpecTypes.ListResourceTemplatesResultResponse
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResultResponse: (
        sdk: z4.infer<typeof Wire2026.ListResourcesResultResponseSchema>,
        spec: SpecTypes.ListResourcesResultResponse
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResultResponse: (sdk: z4.infer<typeof Wire2026.ListToolsResultResponseSchema>, spec: SpecTypes.ListToolsResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    DiscoverResultResponse: (sdk: z4.infer<typeof Wire2026.DiscoverResultResponseSchema>, spec: SpecTypes.DiscoverResultResponse) => {
        sdk = spec;
        spec = sdk;
    },
    RequestParams: (sdk: WRequestParams, spec: SpecTypes.RequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequestParams: (sdk: WPaginatedRequestParams, spec: SpecTypes.PaginatedRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceRequestParams: (sdk: WResourceRequestParams, spec: SpecTypes.ResourceRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequestParams: (sdk: WCompleteRequestParams, spec: SpecTypes.CompleteRequestParams) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequest: (sdk: WPaginatedRequest, spec: SpecTypes.PaginatedRequest) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequest: (sdk: WithJSONRPCRequest<WCompleteRequest>, spec: SpecTypes.CompleteRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsRequest: (sdk: WithJSONRPCRequest<WListPromptsRequest>, spec: SpecTypes.ListPromptsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesRequest: (
        sdk: WithJSONRPCRequest<WListResourceTemplatesRequest>,
        spec: SpecTypes.ListResourceTemplatesRequest
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesRequest: (sdk: WithJSONRPCRequest<WListResourcesRequest>, spec: SpecTypes.ListResourcesRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsRequest: (sdk: WithJSONRPCRequest<WListToolsRequest>, spec: SpecTypes.ListToolsRequest) => {
        sdk = spec;
        spec = sdk;
    }
};

const allTypeChecks = { ...sdkTypeChecks, ...wireParityChecks };

// Generated from the 2026-07-28 schema by `pnpm run fetch:spec-types 2026-07-28 <sha>`.
const SPEC_TYPES_FILE = path.resolve(__dirname, '../src/types/spec.types.2026-07-28.ts');

/**
 * Spec types the 2026-era wire module does not model yet — every entry is
 * OWNED by a named feature issue (no permanent stratum; the list reaches
 * zero as the owners land). Adding a parity check for one of these names
 * forces the entry's removal (stale-check below).
 */
const FEATURE_OWNED_PENDING_2026: Record<string, string> = {
    // Inlined in the SDK (same as the 2025-11-25 comparison):
    Error: 'the inner error object of a JSONRPCError is inlined in the SDK',

    // M4.1 MRTR (#13): the in-band input-request surface and the demoted
    // sampling/elicitation/roots shapes (wire requests in 2025, in-band
    // InputRequest payloads in 2026 — the SDK models them when the
    // multi-round-trip driver lands):
    InputRequest: 'M4.1 MRTR (#13)',
    InputRequests: 'M4.1 MRTR (#13)',
    InputRequiredResult: 'M4.1 MRTR (#13)',
    InputResponse: 'M4.1 MRTR (#13)',
    InputResponseRequestParams: 'M4.1 MRTR (#13)',
    InputResponses: 'M4.1 MRTR (#13)',
    CreateMessageRequest: 'M4.1 MRTR (#13) — demoted to an in-band payload in 2026',
    CreateMessageRequestParams: 'M4.1 MRTR (#13) — demoted to an in-band payload in 2026',
    CreateMessageResult: 'M4.1 MRTR (#13) — in-band response shape',
    ElicitResult: 'M4.1 MRTR (#13) — in-band response shape',
    ListRootsRequest: 'M4.1 MRTR (#13) — demoted to an in-band payload in 2026',
    ListRootsResult: 'M4.1 MRTR (#13) — in-band response shape',
    ServerResult: 'M4.1 MRTR (#13) — the union gains InputRequiredResult',
    CallToolRequestParams: 'M4.1 MRTR (#13) — params extend InputResponseRequestParams (the retry channel)',
    CallToolRequest: 'M4.1 MRTR (#13) — params extend InputResponseRequestParams (the retry channel)',
    GetPromptRequestParams: 'M4.1 MRTR (#13) — params extend InputResponseRequestParams (the retry channel)',
    GetPromptRequest: 'M4.1 MRTR (#13) — params extend InputResponseRequestParams (the retry channel)',
    ReadResourceRequestParams: 'M4.1 MRTR (#13) — params extend InputResponseRequestParams (the retry channel)',
    ReadResourceRequest: 'M4.1 MRTR (#13) — params extend InputResponseRequestParams (the retry channel)',
    CallToolResultResponse: 'M4.1 MRTR (#13) — the result union gains InputRequiredResult',
    GetPromptResultResponse: 'M4.1 MRTR (#13) — the result union gains InputRequiredResult',
    ReadResourceResultResponse: 'M4.1 MRTR (#13) — the result union gains InputRequiredResult',

    // M6.1 subscriptions/listen (#14):
    SubscriptionFilter: 'M6.1 subscriptions/listen (#14)',
    SubscriptionsAcknowledgedNotification: 'M6.1 subscriptions/listen (#14)',
    SubscriptionsAcknowledgedNotificationParams: 'M6.1 subscriptions/listen (#14)',
    SubscriptionsListenRequest: 'M6.1 subscriptions/listen (#14)',
    SubscriptionsListenRequestParams: 'M6.1 subscriptions/listen (#14)',
    ClientRequest: 'M6.1 subscriptions/listen (#14) — the union gains SubscriptionsListenRequest',
    ServerNotification: 'M6.1 subscriptions/listen (#14) — the union gains the acknowledged notification',

    // M1.2 validation ladder (#8): the per-code error response envelopes:
    MissingRequiredClientCapabilityError: 'M1.2 validation ladder (#8)',
    UnsupportedProtocolVersionError: 'M1.2 validation ladder (#8)'
};

const MISSING_SDK_TYPES_2026_07_28 = Object.keys(FEATURE_OWNED_PENDING_2026);

function extractExportedTypes(source: string): string[] {
    const matches = [...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g)];
    return matches.map(m => m[1]!);
}

describe('Spec Types (2026-07-28)', () => {
    const specTypes = extractExportedTypes(fs.readFileSync(SPEC_TYPES_FILE, 'utf8'));
    const typesToCheck = specTypes.filter(type => !MISSING_SDK_TYPES_2026_07_28.includes(type));

    it('pins the 2026-07-28 protocol version and the new error codes', () => {
        expect(LATEST_PROTOCOL_VERSION).toBe('2026-07-28');
        expect(MISSING_REQUIRED_CLIENT_CAPABILITY).toBe(-32003);
        expect(UNSUPPORTED_PROTOCOL_VERSION).toBe(-32004);
        expect(ProtocolErrorCode.MissingRequiredClientCapability).toBe(MISSING_REQUIRED_CLIENT_CAPABILITY);
        expect(ProtocolErrorCode.UnsupportedProtocolVersion).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    });

    it('pins the per-request _meta envelope keys to the 2026-07-28 schema', () => {
        expect(PROTOCOL_VERSION_META_KEY).toBe('io.modelcontextprotocol/protocolVersion');
        expect(CLIENT_INFO_META_KEY).toBe('io.modelcontextprotocol/clientInfo');
        expect(CLIENT_CAPABILITIES_META_KEY).toBe('io.modelcontextprotocol/clientCapabilities');
        expect(LOG_LEVEL_META_KEY).toBe('io.modelcontextprotocol/logLevel');
    });

    it('should define some expected types', () => {
        expect(specTypes).toContain('DiscoverRequest');
        expect(specTypes).toContain('InputRequiredResult');
        expect(specTypes).toContain('SubscriptionsListenRequest');
        expect(specTypes).toHaveLength(151);
    });

    it('should only allowlist types that exist in the 2026-07-28 schema', () => {
        for (const typeName of MISSING_SDK_TYPES_2026_07_28) {
            expect(specTypes).toContain(typeName);
        }
    });

    it('should have comprehensive compatibility tests', () => {
        const missingTests = [];

        for (const typeName of typesToCheck) {
            if (!allTypeChecks[typeName as keyof typeof allTypeChecks]) {
                missingTests.push(typeName);
            }
        }

        expect(missingTests).toHaveLength(0);
    });

    describe('Feature-owned pending entries', () => {
        it.each(MISSING_SDK_TYPES_2026_07_28)('%s must not be pending once it has a parity check (stale-check)', type => {
            expect(allTypeChecks[type as keyof typeof allTypeChecks]).toBeUndefined();
        });

        it('every pending entry names its owner', () => {
            for (const [name, owner] of Object.entries(FEATURE_OWNED_PENDING_2026)) {
                expect(owner.length, name).toBeGreaterThan(0);
            }
        });
    });
});
