/**
 * Compares the SDK's types against the in-progress draft schema (spec.types.draft.ts).
 * The frozen-release comparison lives in spec.types.2025-11-25.test.ts.
 *
 * The SDK does not implement the draft surface yet: every draft type whose shape the SDK
 * does not (yet) match is listed in DRAFT_MISSING_SDK_TYPES below. Removing a name from
 * that list forces a real mutual-assignability check to be added to sdkTypeChecks (the
 * completeness tests below fail otherwise) — implementation work burns the list down.
 *
 * Unlike MISSING_SDK_TYPES in the 2025-11-25 comparison, names in this list may well
 * exist in the SDK (e.g. RequestParams) — they are listed because the draft changed
 * their shape, not necessarily because the SDK lacks them.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
    LATEST_PROTOCOL_VERSION,
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    UNSUPPORTED_PROTOCOL_VERSION
} from '../src/types/spec.types.draft.js';
import type * as SpecTypes from '../src/types/spec.types.draft.js';
import type * as SDKTypes from '../src/types/index.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

// Adds the `jsonrpc` property to a type, to match the on-wire format of notifications.
type WithJSONRPC<T> = T & { jsonrpc: '2.0' };

// Adds the `jsonrpc` and `id` properties to a type, to match the on-wire format of requests.
type WithJSONRPCRequest<T> = T & { jsonrpc: '2.0'; id: SDKTypes.RequestId };

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

// Generated from the draft schema by `pnpm run fetch:spec-types draft <sha>`.
const SPEC_TYPES_FILE = path.resolve(__dirname, '../src/types/spec.types.draft.ts');

/**
 * Draft spec types the SDK does not match yet. Spec-implementation work for the
 * 2026-07-28 release removes entries from this list as the SDK adopts each shape.
 */
const DRAFT_MISSING_SDK_TYPES = [
    // Inlined in the SDK (same as the 2025-11-25 comparison):
    'Error', // The inner error object of a JSONRPCError

    // SEP-2260 per-request envelope: draft requests carry a required `_meta` envelope
    // (`io.modelcontextprotocol/protocolVersion`, clientInfo, clientCapabilities); the SDK
    // still implements the 2025-11-25 request shapes.
    'RequestParams',
    'RequestMetaObject',
    'PaginatedRequestParams',
    'ResourceRequestParams',
    'CallToolRequestParams',
    'CompleteRequestParams',
    'GetPromptRequestParams',
    'ReadResourceRequestParams',
    'CreateMessageRequestParams',
    'PaginatedRequest',
    'CallToolRequest',
    'CompleteRequest',
    'GetPromptRequest',
    'ListPromptsRequest',
    'ListResourceTemplatesRequest',
    'ListResourcesRequest',
    'ListRootsRequest',
    'ListToolsRequest',
    'ReadResourceRequest',
    'CreateMessageRequest',
    'ClientRequest',

    // SEP-2322 (MRTR): draft results carry a required `resultType` discriminator; the SDK
    // still implements the 2025-11-25 result shapes.
    'Result',
    'EmptyResult',
    'PaginatedResult',
    'CallToolResult',
    'CompleteResult',
    'ElicitResult',
    'GetPromptResult',
    'ListPromptsResult',
    'ListResourceTemplatesResult',
    'ListResourcesResult',
    'ListRootsResult',
    'ListToolsResult',
    'ReadResourceResult',
    'CreateMessageResult',
    'ClientResult',
    'ServerResult',
    'ResultType',
    'CacheableResult',

    // Response envelopes embedding the changed Result shape:
    'JSONRPCResultResponse',
    'JSONRPCResponse',
    'JSONRPCMessage',
    'CallToolResultResponse',
    'CompleteResultResponse',
    'GetPromptResultResponse',
    'ListPromptsResultResponse',
    'ListResourceTemplatesResultResponse',
    'ListResourcesResultResponse',
    'ListToolsResultResponse',
    'ReadResourceResultResponse',

    // SEP-2575 sessionless discovery (new surface):
    'DiscoverRequest',
    'DiscoverResult',
    'DiscoverResultResponse',

    // SEP-2567 input requests/responses (new surface):
    'InputRequest',
    'InputRequests',
    'InputRequiredResult',
    'InputResponse',
    'InputResponseRequestParams',
    'InputResponses',

    // Draft subscriptions surface (new):
    'SubscriptionFilter',
    'SubscriptionsAcknowledgedNotification',
    'SubscriptionsAcknowledgedNotificationParams',
    'SubscriptionsListenRequest',
    'SubscriptionsListenRequestParams',

    // New typed protocol errors (-32003 / -32004):
    'MissingRequiredClientCapabilityError',
    'UnsupportedProtocolVersionError',

    // Other shapes changed by the draft schema (sampling content, open tool schemas,
    // loosened Notification.params, server notification union):
    'SamplingMessage',
    'SamplingMessageContentBlock',
    'ToolResultContent',
    'Tool',
    'Notification',
    'ServerNotification'
];

function extractExportedTypes(source: string): string[] {
    const matches = [...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g)];
    return matches.map(m => m[1]!);
}

describe('Spec Types (draft)', () => {
    const specTypes = extractExportedTypes(fs.readFileSync(SPEC_TYPES_FILE, 'utf8'));
    const typesToCheck = specTypes.filter(type => !DRAFT_MISSING_SDK_TYPES.includes(type));

    it('pins the draft protocol version and the new error codes', () => {
        expect(LATEST_PROTOCOL_VERSION).toBe('2026-07-28');
        expect(MISSING_REQUIRED_CLIENT_CAPABILITY).toBe(-32003);
        expect(UNSUPPORTED_PROTOCOL_VERSION).toBe(-32004);
    });

    it('should define some expected types', () => {
        expect(specTypes).toContain('DiscoverRequest');
        expect(specTypes).toContain('InputRequiredResult');
        expect(specTypes).toContain('SubscriptionsListenRequest');
        expect(specTypes).toHaveLength(150);
    });

    it('should only allowlist types that exist in the draft schema', () => {
        for (const typeName of DRAFT_MISSING_SDK_TYPES) {
            expect(specTypes).toContain(typeName);
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
        it.each(DRAFT_MISSING_SDK_TYPES)('%s should not be present in DRAFT_MISSING_SDK_TYPES if it has a compatibility test', type => {
            expect(sdkTypeChecks[type as keyof typeof sdkTypeChecks]).toBeUndefined();
        });
    });
});
