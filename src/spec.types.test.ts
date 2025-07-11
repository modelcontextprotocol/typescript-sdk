/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the SDK's types
 *   (mutually assignable, w/ slight affordances to get rid of ZodObject.passthrough() index signatures, etc)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import * as SDKTypes from "./types.js";
import * as SpecTypes from "../spec.types.js";
import fs from "node:fs";

/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-function-type */

// Removes index signatures added by ZodObject.passthrough().
type RemovePassthrough<T> = T extends object
  ? T extends Array<infer U>
    ? Array<RemovePassthrough<U>>
    : T extends Function
        ? T
        : {[K in keyof T as string extends K ? never : K]: RemovePassthrough<T[K]>}
    : T;

type IsUnknown<T> = [unknown] extends [T] ? [T] extends [unknown] ? true : false : false;

// Turns {x?: unknown} into {x: unknown} but keeps {_meta?: unknown} unchanged (and leaves other optional properties unchanged, e.g. {x?: string}).
// This works around an apparent quirk of ZodObject.unknown() (makes fields optional)
type MakeUnknownsNotOptional<T> =
  IsUnknown<T> extends true
    ? unknown
    : (T extends object
      ? (T extends Array<infer U>
        ? Array<MakeUnknownsNotOptional<U>>
        : (T extends Function
          ? T
          : Pick<T, never> & {
            // Start with empty object to avoid duplicates
            // Make unknown properties required (except _meta)
            [K in keyof T as '_meta' extends K ? never : IsUnknown<T[K]> extends true ? K : never]-?: unknown;
          } &
          Pick<T, {
            // Pick all _meta and non-unknown properties with original modifiers
            [K in keyof T]: '_meta' extends K ? K : IsUnknown<T[K]> extends true ? never : K
          }[keyof T]> & {
            // Recurse on the picked properties
            [K in keyof Pick<T, {[K in keyof T]: '_meta' extends K ? K : IsUnknown<T[K]> extends true ? never : K}[keyof T]>]: MakeUnknownsNotOptional<T[K]>
          }))
      : T);

function checkCancelledNotification(
  sdk: SDKTypes.CancelledNotification,
  spec: SpecTypes.CancelledNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkBaseMetadata(
  sdk: RemovePassthrough<SDKTypes.BaseMetadata>,
  spec: SpecTypes.BaseMetadata
) {
  sdk = spec;
  spec = sdk;
}
function checkImplementation(
  sdk: RemovePassthrough<SDKTypes.Implementation>,
  spec: SpecTypes.Implementation
) {
  sdk = spec;
  spec = sdk;
}
function checkProgressNotification(
  sdk: SDKTypes.ProgressNotification,
  spec: SpecTypes.ProgressNotification
) {
  sdk = spec;
  spec = sdk;
}

function checkSubscribeRequest(
  sdk: SDKTypes.SubscribeRequest,
  spec: SpecTypes.SubscribeRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkUnsubscribeRequest(
  sdk: SDKTypes.UnsubscribeRequest,
  spec: SpecTypes.UnsubscribeRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkPaginatedRequest(
  sdk: SDKTypes.PaginatedRequest,
  spec: SpecTypes.PaginatedRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkPaginatedResult(
  sdk: SDKTypes.PaginatedResult,
  spec: SpecTypes.PaginatedResult
) {
  sdk = spec;
  spec = sdk;
}
function checkListRootsRequest(
  sdk: SDKTypes.ListRootsRequest,
  spec: SpecTypes.ListRootsRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkListRootsResult(
  sdk: RemovePassthrough<SDKTypes.ListRootsResult>,
  spec: SpecTypes.ListRootsResult
) {
  sdk = spec;
  spec = sdk;
}
function checkRoot(
  sdk: RemovePassthrough<SDKTypes.Root>,
  spec: SpecTypes.Root
) {
  sdk = spec;
  spec = sdk;
}
function checkElicitRequest(
  sdk: RemovePassthrough<SDKTypes.ElicitRequest>,
  spec: SpecTypes.ElicitRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkElicitResult(
  sdk: RemovePassthrough<SDKTypes.ElicitResult>,
  spec: SpecTypes.ElicitResult
) {
  sdk = spec;
  spec = sdk;
}
function checkCompleteRequest(
  sdk: RemovePassthrough<SDKTypes.CompleteRequest>,
  spec: SpecTypes.CompleteRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkCompleteResult(
  sdk: SDKTypes.CompleteResult,
  spec: SpecTypes.CompleteResult
) {
  sdk = spec;
  spec = sdk;
}
function checkProgressToken(
  sdk: SDKTypes.ProgressToken,
  spec: SpecTypes.ProgressToken
) {
  sdk = spec;
  spec = sdk;
}
function checkCursor(
  sdk: SDKTypes.Cursor,
  spec: SpecTypes.Cursor
) {
  sdk = spec;
  spec = sdk;
}
function checkRequest(
  sdk: SDKTypes.Request,
  spec: SpecTypes.Request
) {
  sdk = spec;
  spec = sdk;
}
function checkResult(
  sdk: SDKTypes.Result,
  spec: SpecTypes.Result
) {
  sdk = spec;
  spec = sdk;
}
function checkRequestId(
  sdk: SDKTypes.RequestId,
  spec: SpecTypes.RequestId
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCRequest(
  sdk: SDKTypes.JSONRPCRequest,
  spec: SpecTypes.JSONRPCRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCNotification(
  sdk: SDKTypes.JSONRPCNotification,
  spec: SpecTypes.JSONRPCNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCResponse(
  sdk: SDKTypes.JSONRPCResponse,
  spec: SpecTypes.JSONRPCResponse
) {
  sdk = spec;
  spec = sdk;
}
function checkEmptyResult(
  sdk: SDKTypes.EmptyResult,
  spec: SpecTypes.EmptyResult
) {
  sdk = spec;
  spec = sdk;
}
function checkNotification(
  sdk: SDKTypes.Notification,
  spec: SpecTypes.Notification
) {
  sdk = spec;
  spec = sdk;
}
function checkClientResult(
  sdk: SDKTypes.ClientResult,
  spec: SpecTypes.ClientResult
) {
  sdk = spec;
  spec = sdk;
}
function checkClientNotification(
  sdk: SDKTypes.ClientNotification,
  spec: SpecTypes.ClientNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkServerResult(
  sdk: SDKTypes.ServerResult,
  spec: SpecTypes.ServerResult
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceTemplateReference(
  sdk: RemovePassthrough<SDKTypes.ResourceTemplateReference>,
  spec: SpecTypes.ResourceTemplateReference
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptReference(
  sdk: RemovePassthrough<SDKTypes.PromptReference>,
  spec: SpecTypes.PromptReference
) {
  sdk = spec;
  spec = sdk;
}
function checkToolAnnotations(
  sdk: RemovePassthrough<SDKTypes.ToolAnnotations>,
  spec: SpecTypes.ToolAnnotations
) {
  sdk = spec;
  spec = sdk;
}
function checkTool(
  sdk: RemovePassthrough<SDKTypes.Tool>,
  spec: SpecTypes.Tool
) {
  sdk = spec;
  spec = sdk;
}
function checkListToolsRequest(
  sdk: SDKTypes.ListToolsRequest,
  spec: SpecTypes.ListToolsRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkListToolsResult(
  sdk: RemovePassthrough<SDKTypes.ListToolsResult>,
  spec: SpecTypes.ListToolsResult
) {
  sdk = spec;
  spec = sdk;
}
function checkCallToolResult(
  sdk: RemovePassthrough<SDKTypes.CallToolResult>,
  spec: SpecTypes.CallToolResult
) {
  sdk = spec;
  spec = sdk;
}
function checkCallToolRequest(
  sdk: SDKTypes.CallToolRequest,
  spec: SpecTypes.CallToolRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkToolListChangedNotification(
  sdk: SDKTypes.ToolListChangedNotification,
  spec: SpecTypes.ToolListChangedNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceListChangedNotification(
  sdk: SDKTypes.ResourceListChangedNotification,
  spec: SpecTypes.ResourceListChangedNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptListChangedNotification(
  sdk: SDKTypes.PromptListChangedNotification,
  spec: SpecTypes.PromptListChangedNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkRootsListChangedNotification(
  sdk: SDKTypes.RootsListChangedNotification,
  spec: SpecTypes.RootsListChangedNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceUpdatedNotification(
  sdk: SDKTypes.ResourceUpdatedNotification,
  spec: SpecTypes.ResourceUpdatedNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkSamplingMessage(
  sdk: RemovePassthrough<SDKTypes.SamplingMessage>,
  spec: SpecTypes.SamplingMessage
) {
  sdk = spec;
  spec = sdk;
}
function checkCreateMessageResult(
  sdk: RemovePassthrough<SDKTypes.CreateMessageResult>,
  spec: SpecTypes.CreateMessageResult
) {
  sdk = spec;
  spec = sdk;
}
function checkSetLevelRequest(
  sdk: SDKTypes.SetLevelRequest,
  spec: SpecTypes.SetLevelRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkPingRequest(
  sdk: SDKTypes.PingRequest,
  spec: SpecTypes.PingRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializedNotification(
  sdk: SDKTypes.InitializedNotification,
  spec: SpecTypes.InitializedNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourcesRequest(
  sdk: SDKTypes.ListResourcesRequest,
  spec: SpecTypes.ListResourcesRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourcesResult(
  sdk: RemovePassthrough<SDKTypes.ListResourcesResult>,
  spec: SpecTypes.ListResourcesResult
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourceTemplatesRequest(
  sdk: SDKTypes.ListResourceTemplatesRequest,
  spec: SpecTypes.ListResourceTemplatesRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkListResourceTemplatesResult(
  sdk: RemovePassthrough<SDKTypes.ListResourceTemplatesResult>,
  spec: SpecTypes.ListResourceTemplatesResult
) {
  sdk = spec;
  spec = sdk;
}
function checkReadResourceRequest(
  sdk: SDKTypes.ReadResourceRequest,
  spec: SpecTypes.ReadResourceRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkReadResourceResult(
  sdk: RemovePassthrough<SDKTypes.ReadResourceResult>,
  spec: SpecTypes.ReadResourceResult
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceContents(
  sdk: RemovePassthrough<SDKTypes.ResourceContents>,
  spec: SpecTypes.ResourceContents
) {
  sdk = spec;
  spec = sdk;
}
function checkTextResourceContents(
  sdk: RemovePassthrough<SDKTypes.TextResourceContents>,
  spec: SpecTypes.TextResourceContents
) {
  sdk = spec;
  spec = sdk;
}
function checkBlobResourceContents(
  sdk: RemovePassthrough<SDKTypes.BlobResourceContents>,
  spec: SpecTypes.BlobResourceContents
) {
  sdk = spec;
  spec = sdk;
}
function checkResource(
  sdk: RemovePassthrough<SDKTypes.Resource>,
  spec: SpecTypes.Resource
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceTemplate(
  sdk: RemovePassthrough<SDKTypes.ResourceTemplate>,
  spec: SpecTypes.ResourceTemplate
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptArgument(
  sdk: RemovePassthrough<SDKTypes.PromptArgument>,
  spec: SpecTypes.PromptArgument
) {
  sdk = spec;
  spec = sdk;
}
function checkPrompt(
  sdk: RemovePassthrough<SDKTypes.Prompt>,
  spec: SpecTypes.Prompt
) {
  sdk = spec;
  spec = sdk;
}
function checkListPromptsRequest(
  sdk: SDKTypes.ListPromptsRequest,
  spec: SpecTypes.ListPromptsRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkListPromptsResult(
  sdk: RemovePassthrough<SDKTypes.ListPromptsResult>,
  spec: SpecTypes.ListPromptsResult
) {
  sdk = spec;
  spec = sdk;
}
function checkGetPromptRequest(
  sdk: SDKTypes.GetPromptRequest,
  spec: SpecTypes.GetPromptRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkTextContent(
  sdk: RemovePassthrough<SDKTypes.TextContent>,
  spec: SpecTypes.TextContent
) {
  sdk = spec;
  spec = sdk;
}
function checkImageContent(
  sdk: RemovePassthrough<SDKTypes.ImageContent>,
  spec: SpecTypes.ImageContent
) {
  sdk = spec;
  spec = sdk;
}
function checkAudioContent(
  sdk: RemovePassthrough<SDKTypes.AudioContent>,
  spec: SpecTypes.AudioContent
) {
  sdk = spec;
  spec = sdk;
}
function checkEmbeddedResource(
  sdk: RemovePassthrough<SDKTypes.EmbeddedResource>,
  spec: SpecTypes.EmbeddedResource
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceLink(
  sdk: RemovePassthrough<SDKTypes.ResourceLink>,
  spec: SpecTypes.ResourceLink
) {
  sdk = spec;
  spec = sdk;
}
function checkContentBlock(
  sdk: RemovePassthrough<SDKTypes.ContentBlock>,
  spec: SpecTypes.ContentBlock
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptMessage(
  sdk: RemovePassthrough<SDKTypes.PromptMessage>,
  spec: SpecTypes.PromptMessage
) {
  sdk = spec;
  spec = sdk;
}
function checkGetPromptResult(
  sdk: RemovePassthrough<SDKTypes.GetPromptResult>,
  spec: SpecTypes.GetPromptResult
) {
  sdk = spec;
  spec = sdk;
}
function checkBooleanSchema(
  sdk: RemovePassthrough<SDKTypes.BooleanSchema>,
  spec: SpecTypes.BooleanSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkStringSchema(
  sdk: RemovePassthrough<SDKTypes.StringSchema>,
  spec: SpecTypes.StringSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkNumberSchema(
  sdk: RemovePassthrough<SDKTypes.NumberSchema>,
  spec: SpecTypes.NumberSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkEnumSchema(
  sdk: RemovePassthrough<SDKTypes.EnumSchema>,
  spec: SpecTypes.EnumSchema
) {
  sdk = spec;
  spec = sdk;
}
function checkPrimitiveSchemaDefinition(
  sdk: RemovePassthrough<SDKTypes.PrimitiveSchemaDefinition>,
  spec: SpecTypes.PrimitiveSchemaDefinition
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCError(
  sdk: SDKTypes.JSONRPCError,
  spec: SpecTypes.JSONRPCError
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCMessage(
  sdk: SDKTypes.JSONRPCMessage,
  spec: SpecTypes.JSONRPCMessage
) {
  sdk = spec;
  spec = sdk;
}
function checkCreateMessageRequest(
  sdk: RemovePassthrough<SDKTypes.CreateMessageRequest>,
  spec: SpecTypes.CreateMessageRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializeRequest(
  sdk: RemovePassthrough<SDKTypes.InitializeRequest>,
  spec: SpecTypes.InitializeRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializeResult(
  sdk: RemovePassthrough<SDKTypes.InitializeResult>,
  spec: SpecTypes.InitializeResult
) {
  sdk = spec;
  spec = sdk;
}
function checkClientCapabilities(
  sdk: RemovePassthrough<SDKTypes.ClientCapabilities>,
  spec: SpecTypes.ClientCapabilities
) {
  sdk = spec;
  spec = sdk;
}
function checkServerCapabilities(
  sdk: RemovePassthrough<SDKTypes.ServerCapabilities>,
  spec: SpecTypes.ServerCapabilities
) {
  sdk = spec;
  spec = sdk;
}
function checkClientRequest(
  sdk: RemovePassthrough<SDKTypes.ClientRequest>,
  spec: SpecTypes.ClientRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkServerRequest(
  sdk: RemovePassthrough<SDKTypes.ServerRequest>,
  spec: SpecTypes.ServerRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkLoggingMessageNotification(
  sdk: MakeUnknownsNotOptional<SDKTypes.LoggingMessageNotification>,
  spec: SpecTypes.LoggingMessageNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkServerNotification(
  sdk: MakeUnknownsNotOptional<SDKTypes.ServerNotification>,
  spec: SpecTypes.ServerNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkLoggingLevel(
  sdk: SDKTypes.LoggingLevel,
  spec: SpecTypes.LoggingLevel
) {
  sdk = spec;
  spec = sdk;
}

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE  = 'spec.types.ts';
const SDK_TYPES_FILE  = 'src/types.ts';

const MISSING_SDK_TYPES = [
  // These are inlined in the SDK:
  'Role',

  // These aren't supported by the SDK yet:
  // TODO: Add definitions to the SDK
  'Annotations',
  'ModelHint',
  'ModelPreferences',
]

function extractExportedTypes(source: string): string[] {
  return [...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g)].map(m => m[1]);
}

describe('Spec Types', () => {
  const specTypes = extractExportedTypes(fs.readFileSync(SPEC_TYPES_FILE, 'utf-8'));
  const sdkTypes = extractExportedTypes(fs.readFileSync(SDK_TYPES_FILE, 'utf-8'));
  const testSource = fs.readFileSync(__filename, 'utf-8');

  it('should define some expected types', () => {
    expect(specTypes).toContain('JSONRPCNotification');
    expect(specTypes).toContain('ElicitResult');
    expect(specTypes).toHaveLength(91);
  });

  it('should have up to date list of missing sdk types', () => {
    for (const typeName of MISSING_SDK_TYPES) {
      expect(sdkTypes).not.toContain(typeName);
    }
  });

  for (const type of specTypes) {
    if (MISSING_SDK_TYPES.includes(type)) {
      continue; // Skip missing SDK types
    }
    it(`${type} should have a compatibility test`, () => {
      expect(testSource).toContain(`function check${type}(`);
    });
  }
});
