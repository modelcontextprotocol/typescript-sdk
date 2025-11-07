/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the SDK's types
 *   (mutually assignable, w/ slight affordances to get rid of ZodObject.passthrough() index signatures, etc)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import * as SDKTypes from './types.js';
import * as SpecTypes from './spec.types.js';
import fs from 'node:fs';

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// Removes index signatures added by ZodObject.passthrough().
type RemovePassthrough<T> = T extends object
    ? T extends Array<infer U>
        ? Array<RemovePassthrough<U>>
        : T extends Function
          ? T
          : {
                [K in keyof T as string extends K ? never : K]: RemovePassthrough<T[K]>;
            }
    : T;

// Adds the `jsonrpc` property to a type, to match the on-wire format of notifications.
type WithJSONRPC<T> = T & { jsonrpc: '2.0' };

// Adds the `jsonrpc` and `id` properties to a type, to match the on-wire format of requests.
type WithJSONRPCRequest<T> = T & { jsonrpc: '2.0'; id: SDKTypes.RequestId };

type IsUnknown<T> = [unknown] extends [T] ? ([T] extends [unknown] ? true : false) : false;

// Turns {x?: unknown} into {x: unknown} but keeps {_meta?: unknown} unchanged (and leaves other optional properties unchanged, e.g. {x?: string}).
// This works around an apparent quirk of ZodObject.unknown() (makes fields optional)
type MakeUnknownsNotOptional<T> =
    IsUnknown<T> extends true
        ? unknown
        : T extends object
          ? T extends Array<infer U>
              ? Array<MakeUnknownsNotOptional<U>>
              : T extends Function
                ? T
                : Pick<T, never> & {
                      // Start with empty object to avoid duplicates
                      // Make unknown properties required (except _meta)
                      [K in keyof T as '_meta' extends K ? never : IsUnknown<T[K]> extends true ? K : never]-?: unknown;
                  } & Pick<
                          T,
                          {
                              // Pick all _meta and non-unknown properties with original modifiers
                              [K in keyof T]: '_meta' extends K ? K : IsUnknown<T[K]> extends true ? never : K;
                          }[keyof T]
                      > & {
                          // Recurse on the picked properties
                          [K in keyof Pick<
                              T,
                              {
                                  [K in keyof T]: '_meta' extends K ? K : IsUnknown<T[K]> extends true ? never : K;
                              }[keyof T]
                          >]: MakeUnknownsNotOptional<T[K]>;
                      }
          : T;

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
        sdk: MakeUnknownsNotOptional<SDKTypes.LoggingMessageNotificationParams>,
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
    ProgressNotification: (sdk: RemovePassthrough<WithJSONRPC<SDKTypes.ProgressNotification>>, spec: SpecTypes.ProgressNotification) => {
        sdk = spec;
        spec = sdk;
    },
    SubscribeRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.SubscribeRequest>>, spec: SpecTypes.SubscribeRequest) => {
        sdk = spec;
        spec = sdk;
    },
    UnsubscribeRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.UnsubscribeRequest>>, spec: SpecTypes.UnsubscribeRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.PaginatedRequest>>, spec: SpecTypes.PaginatedRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PaginatedResult: (sdk: SDKTypes.PaginatedResult, spec: SpecTypes.PaginatedResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListRootsRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ListRootsRequest>>, spec: SpecTypes.ListRootsRequest) => {
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
    ClientNotification: (sdk: RemovePassthrough<WithJSONRPC<SDKTypes.ClientNotification>>, spec: SpecTypes.ClientNotification) => {
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
    ListToolsRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ListToolsRequest>>, spec: SpecTypes.ListToolsRequest) => {
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
    CallToolRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.CallToolRequest>>, spec: SpecTypes.CallToolRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ToolListChangedNotification: (
        sdk: RemovePassthrough<WithJSONRPC<SDKTypes.ToolListChangedNotification>>,
        spec: SpecTypes.ToolListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceListChangedNotification: (
        sdk: RemovePassthrough<WithJSONRPC<SDKTypes.ResourceListChangedNotification>>,
        spec: SpecTypes.ResourceListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    PromptListChangedNotification: (
        sdk: RemovePassthrough<WithJSONRPC<SDKTypes.PromptListChangedNotification>>,
        spec: SpecTypes.PromptListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    RootsListChangedNotification: (
        sdk: RemovePassthrough<WithJSONRPC<SDKTypes.RootsListChangedNotification>>,
        spec: SpecTypes.RootsListChangedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceUpdatedNotification: (
        sdk: RemovePassthrough<WithJSONRPC<SDKTypes.ResourceUpdatedNotification>>,
        spec: SpecTypes.ResourceUpdatedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    SamplingMessage: (sdk: SDKTypes.SamplingMessage, spec: SpecTypes.SamplingMessage) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageResult: (sdk: SDKTypes.CreateMessageResult, spec: SpecTypes.CreateMessageResult) => {
        sdk = spec;
        spec = sdk;
    },
    SetLevelRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.SetLevelRequest>>, spec: SpecTypes.SetLevelRequest) => {
        sdk = spec;
        spec = sdk;
    },
    PingRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.PingRequest>>, spec: SpecTypes.PingRequest) => {
        sdk = spec;
        spec = sdk;
    },
    InitializedNotification: (
        sdk: RemovePassthrough<WithJSONRPC<SDKTypes.InitializedNotification>>,
        spec: SpecTypes.InitializedNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesRequest: (
        sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ListResourcesRequest>>,
        spec: SpecTypes.ListResourcesRequest
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourcesResult: (sdk: SDKTypes.ListResourcesResult, spec: SpecTypes.ListResourcesResult) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesRequest: (
        sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ListResourceTemplatesRequest>>,
        spec: SpecTypes.ListResourceTemplatesRequest
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ListResourceTemplatesResult: (sdk: SDKTypes.ListResourceTemplatesResult, spec: SpecTypes.ListResourceTemplatesResult) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceRequest: (
        sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ReadResourceRequest>>,
        spec: SpecTypes.ReadResourceRequest
    ) => {
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
    ResourceTemplate: (sdk: SDKTypes.ResourceTemplate, spec: SpecTypes.ResourceTemplate) => {
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
    ListPromptsRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ListPromptsRequest>>, spec: SpecTypes.ListPromptsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResult: (sdk: SDKTypes.ListPromptsResult, spec: SpecTypes.ListPromptsResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.GetPromptRequest>>, spec: SpecTypes.GetPromptRequest) => {
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
    PrimitiveSchemaDefinition: (sdk: SDKTypes.PrimitiveSchemaDefinition, spec: SpecTypes.PrimitiveSchemaDefinition) => {
        sdk = spec;
        spec = sdk;
    },
    JSONRPCError: (sdk: SDKTypes.JSONRPCError, spec: SpecTypes.JSONRPCError) => {
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
    ClientRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ClientRequest>>, spec: SpecTypes.ClientRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ServerRequest: (sdk: RemovePassthrough<WithJSONRPCRequest<SDKTypes.ServerRequest>>, spec: SpecTypes.ServerRequest) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingMessageNotification: (
        sdk: RemovePassthrough<MakeUnknownsNotOptional<WithJSONRPC<SDKTypes.LoggingMessageNotification>>>,
        spec: SpecTypes.LoggingMessageNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ServerNotification: (
        sdk: MakeUnknownsNotOptional<RemovePassthrough<WithJSONRPC<SDKTypes.ServerNotification>>>,
        spec: SpecTypes.ServerNotification
    ) => {
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
    }
};

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE = 'src/spec.types.ts';
const SDK_TYPES_FILE = 'src/types.ts';

const MISSING_SDK_TYPES = [
    // These are inlined in the SDK:
    'Role',
    'Error', // The inner error object of a JSONRPCError
    // These aren't supported by the SDK yet:
    // TODO: Add definitions to the SDK
    'Annotations'
];

function extractExportedTypes(source: string): string[] {
    return [...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g)].map(m => m[1]);
}

describe('Spec Types', () => {
    const specTypes = extractExportedTypes(fs.readFileSync(SPEC_TYPES_FILE, 'utf-8'));
    const sdkTypes = extractExportedTypes(fs.readFileSync(SDK_TYPES_FILE, 'utf-8'));
    const typesToCheck = specTypes.filter(type => !MISSING_SDK_TYPES.includes(type));

    it('should define some expected types', () => {
        expect(specTypes).toContain('JSONRPCNotification');
        expect(specTypes).toContain('ElicitResult');
        expect(specTypes).toHaveLength(112);
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
