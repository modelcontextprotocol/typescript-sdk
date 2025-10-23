/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the SDK's types
 *   (mutually assignable, w/ slight affordances to get rid of ZodObject.passthrough() index signatures, etc)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import * as SDKTypes from './types.js';
import * as SpecTypes from '../spec.types.js';
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
    CancelledNotification: (sdk: WithJSONRPC<SDKTypes.CancelledNotification>, spec: SpecTypes.CancelledNotification) => {
        sdk = spec;
        spec = sdk;
    },
    BaseMetadata: (sdk: RemovePassthrough<SDKTypes.BaseMetadata>, spec: SpecTypes.BaseMetadata) => {
        sdk = spec;
        spec = sdk;
    },
    Implementation: (sdk: RemovePassthrough<SDKTypes.Implementation>, spec: SpecTypes.Implementation) => {
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
    ListRootsResult: (sdk: RemovePassthrough<SDKTypes.ListRootsResult>, spec: SpecTypes.ListRootsResult) => {
        sdk = spec;
        spec = sdk;
    },
    Root: (sdk: RemovePassthrough<SDKTypes.Root>, spec: SpecTypes.Root) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitRequest: (sdk: WithJSONRPCRequest<RemovePassthrough<SDKTypes.ElicitRequest>>, spec: SpecTypes.ElicitRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ElicitResult: (sdk: RemovePassthrough<SDKTypes.ElicitResult>, spec: SpecTypes.ElicitResult) => {
        sdk = spec;
        spec = sdk;
    },
    CompleteRequest: (sdk: WithJSONRPCRequest<RemovePassthrough<SDKTypes.CompleteRequest>>, spec: SpecTypes.CompleteRequest) => {
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
    ResourceTemplateReference: (sdk: RemovePassthrough<SDKTypes.ResourceTemplateReference>, spec: SpecTypes.ResourceTemplateReference) => {
        sdk = spec;
        spec = sdk;
    },
    PromptReference: (sdk: RemovePassthrough<SDKTypes.PromptReference>, spec: SpecTypes.PromptReference) => {
        sdk = spec;
        spec = sdk;
    },
    ToolAnnotations: (sdk: RemovePassthrough<SDKTypes.ToolAnnotations>, spec: SpecTypes.ToolAnnotations) => {
        sdk = spec;
        spec = sdk;
    },
    Tool: (sdk: RemovePassthrough<SDKTypes.Tool>, spec: SpecTypes.Tool) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListToolsRequest>, spec: SpecTypes.ListToolsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListToolsResult: (sdk: RemovePassthrough<SDKTypes.ListToolsResult>, spec: SpecTypes.ListToolsResult) => {
        sdk = spec;
        spec = sdk;
    },
    CallToolResult: (sdk: RemovePassthrough<SDKTypes.CallToolResult>, spec: SpecTypes.CallToolResult) => {
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
    SamplingMessage: (sdk: RemovePassthrough<SDKTypes.SamplingMessage>, spec: SpecTypes.SamplingMessage) => {
        sdk = spec;
        spec = sdk;
    },
    CreateMessageResult: (sdk: RemovePassthrough<SDKTypes.CreateMessageResult>, spec: SpecTypes.CreateMessageResult) => {
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
    ListResourcesResult: (sdk: RemovePassthrough<SDKTypes.ListResourcesResult>, spec: SpecTypes.ListResourcesResult) => {
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
    ListResourceTemplatesResult: (
        sdk: RemovePassthrough<SDKTypes.ListResourceTemplatesResult>,
        spec: SpecTypes.ListResourceTemplatesResult
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceRequest: (sdk: WithJSONRPCRequest<SDKTypes.ReadResourceRequest>, spec: SpecTypes.ReadResourceRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ReadResourceResult: (sdk: RemovePassthrough<SDKTypes.ReadResourceResult>, spec: SpecTypes.ReadResourceResult) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceContents: (sdk: RemovePassthrough<SDKTypes.ResourceContents>, spec: SpecTypes.ResourceContents) => {
        sdk = spec;
        spec = sdk;
    },
    TextResourceContents: (sdk: RemovePassthrough<SDKTypes.TextResourceContents>, spec: SpecTypes.TextResourceContents) => {
        sdk = spec;
        spec = sdk;
    },
    BlobResourceContents: (sdk: RemovePassthrough<SDKTypes.BlobResourceContents>, spec: SpecTypes.BlobResourceContents) => {
        sdk = spec;
        spec = sdk;
    },
    Resource: (sdk: RemovePassthrough<SDKTypes.Resource>, spec: SpecTypes.Resource) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceTemplate: (sdk: RemovePassthrough<SDKTypes.ResourceTemplate>, spec: SpecTypes.ResourceTemplate) => {
        sdk = spec;
        spec = sdk;
    },
    PromptArgument: (sdk: RemovePassthrough<SDKTypes.PromptArgument>, spec: SpecTypes.PromptArgument) => {
        sdk = spec;
        spec = sdk;
    },
    Prompt: (sdk: RemovePassthrough<SDKTypes.Prompt>, spec: SpecTypes.Prompt) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsRequest: (sdk: WithJSONRPCRequest<SDKTypes.ListPromptsRequest>, spec: SpecTypes.ListPromptsRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ListPromptsResult: (sdk: RemovePassthrough<SDKTypes.ListPromptsResult>, spec: SpecTypes.ListPromptsResult) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptRequest: (sdk: WithJSONRPCRequest<SDKTypes.GetPromptRequest>, spec: SpecTypes.GetPromptRequest) => {
        sdk = spec;
        spec = sdk;
    },
    TextContent: (sdk: RemovePassthrough<SDKTypes.TextContent>, spec: SpecTypes.TextContent) => {
        sdk = spec;
        spec = sdk;
    },
    ImageContent: (sdk: RemovePassthrough<SDKTypes.ImageContent>, spec: SpecTypes.ImageContent) => {
        sdk = spec;
        spec = sdk;
    },
    AudioContent: (sdk: RemovePassthrough<SDKTypes.AudioContent>, spec: SpecTypes.AudioContent) => {
        sdk = spec;
        spec = sdk;
    },
    EmbeddedResource: (sdk: RemovePassthrough<SDKTypes.EmbeddedResource>, spec: SpecTypes.EmbeddedResource) => {
        sdk = spec;
        spec = sdk;
    },
    ResourceLink: (sdk: RemovePassthrough<SDKTypes.ResourceLink>, spec: SpecTypes.ResourceLink) => {
        sdk = spec;
        spec = sdk;
    },
    ContentBlock: (sdk: RemovePassthrough<SDKTypes.ContentBlock>, spec: SpecTypes.ContentBlock) => {
        sdk = spec;
        spec = sdk;
    },
    PromptMessage: (sdk: RemovePassthrough<SDKTypes.PromptMessage>, spec: SpecTypes.PromptMessage) => {
        sdk = spec;
        spec = sdk;
    },
    GetPromptResult: (sdk: RemovePassthrough<SDKTypes.GetPromptResult>, spec: SpecTypes.GetPromptResult) => {
        sdk = spec;
        spec = sdk;
    },
    BooleanSchema: (sdk: RemovePassthrough<SDKTypes.BooleanSchema>, spec: SpecTypes.BooleanSchema) => {
        sdk = spec;
        spec = sdk;
    },
    StringSchema: (sdk: RemovePassthrough<SDKTypes.StringSchema>, spec: SpecTypes.StringSchema) => {
        sdk = spec;
        spec = sdk;
    },
    NumberSchema: (sdk: RemovePassthrough<SDKTypes.NumberSchema>, spec: SpecTypes.NumberSchema) => {
        sdk = spec;
        spec = sdk;
    },
    EnumSchema: (sdk: RemovePassthrough<SDKTypes.EnumSchema>, spec: SpecTypes.EnumSchema) => {
        sdk = spec;
        spec = sdk;
    },
    PrimitiveSchemaDefinition: (sdk: RemovePassthrough<SDKTypes.PrimitiveSchemaDefinition>, spec: SpecTypes.PrimitiveSchemaDefinition) => {
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
    CreateMessageRequest: (
        sdk: WithJSONRPCRequest<RemovePassthrough<SDKTypes.CreateMessageRequest>>,
        spec: SpecTypes.CreateMessageRequest
    ) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeRequest: (sdk: WithJSONRPCRequest<RemovePassthrough<SDKTypes.InitializeRequest>>, spec: SpecTypes.InitializeRequest) => {
        sdk = spec;
        spec = sdk;
    },
    InitializeResult: (sdk: RemovePassthrough<SDKTypes.InitializeResult>, spec: SpecTypes.InitializeResult) => {
        sdk = spec;
        spec = sdk;
    },
    ClientCapabilities: (sdk: RemovePassthrough<SDKTypes.ClientCapabilities>, spec: SpecTypes.ClientCapabilities) => {
        sdk = spec;
        spec = sdk;
    },
    ServerCapabilities: (sdk: RemovePassthrough<SDKTypes.ServerCapabilities>, spec: SpecTypes.ServerCapabilities) => {
        sdk = spec;
        spec = sdk;
    },
    ClientRequest: (sdk: WithJSONRPCRequest<RemovePassthrough<SDKTypes.ClientRequest>>, spec: SpecTypes.ClientRequest) => {
        sdk = spec;
        spec = sdk;
    },
    ServerRequest: (sdk: WithJSONRPCRequest<RemovePassthrough<SDKTypes.ServerRequest>>, spec: SpecTypes.ServerRequest) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingMessageNotification: (
        sdk: MakeUnknownsNotOptional<WithJSONRPC<SDKTypes.LoggingMessageNotification>>,
        spec: SpecTypes.LoggingMessageNotification
    ) => {
        sdk = spec;
        spec = sdk;
    },
    ServerNotification: (sdk: MakeUnknownsNotOptional<WithJSONRPC<SDKTypes.ServerNotification>>, spec: SpecTypes.ServerNotification) => {
        sdk = spec;
        spec = sdk;
    },
    LoggingLevel: (sdk: SDKTypes.LoggingLevel, spec: SpecTypes.LoggingLevel) => {
        sdk = spec;
        spec = sdk;
    },
    Icon: (sdk: RemovePassthrough<SDKTypes.Icon>, spec: SpecTypes.Icon) => {
        sdk = spec;
        spec = sdk;
    },
    Icons: (sdk: RemovePassthrough<SDKTypes.Icons>, spec: SpecTypes.Icons) => {
        sdk = spec;
        spec = sdk;
    }
};

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE = 'spec.types.ts';
const SDK_TYPES_FILE = 'src/types.ts';

const MISSING_SDK_TYPES = [
    // These are inlined in the SDK:
    'Role',
    'Error', // The inner error object of a JSONRPCError

    // These aren't supported by the SDK yet:
    // TODO: Add definitions to the SDK
    'Annotations',
    'ModelHint',
    'ModelPreferences'
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
        expect(specTypes).toHaveLength(94);
    });

    it('should have up to date list of missing sdk types', () => {
        for (const typeName of MISSING_SDK_TYPES) {
            expect(sdkTypes).not.toContain(typeName);
        }
    });

    describe('Compatibility tests', () => {
        it.each(typesToCheck)('%s should have a compatibility test', type => {
            expect(sdkTypeChecks[type as keyof typeof sdkTypeChecks]).toBeDefined();
        });
    });

    describe('Missing SDK Types', () => {
        it.each(MISSING_SDK_TYPES)('%s should not be present in MISSING_SDK_TYPES if it has a compatibility test', type => {
            expect(sdkTypeChecks[type as keyof typeof sdkTypeChecks]).toBeUndefined();
        });
    });
});
