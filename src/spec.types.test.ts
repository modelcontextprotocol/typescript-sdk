// import ts from 'typescript';

import * as SDKTypes from "./types.js";
import * as SpecTypes from "./spec.types.js";

// Deep version that recursively removes index signatures (caused by ZodObject.passthrough()) and turns unknowns into `object | undefined`
type DeepKnownKeys<T> = T extends object
  ? T extends Array<infer U>
    ? Array<DeepKnownKeys<U>>
    : T extends Function
    ? T
    : {
        [K in keyof T as string extends K ? never : number extends K ? never : K]: DeepKnownKeys<T[K]>;
      }
  : unknown extends T
  ? (object | undefined)
  : T;

function checkCancelledNotification(
  sdk: SDKTypes.CancelledNotification,
  spec: SpecTypes.CancelledNotification
) {
  sdk = spec;
  spec = sdk;
}
function checkBaseMetadata(
  sdk: SDKTypes.BaseMetadata,
  spec: DeepKnownKeys<SpecTypes.BaseMetadata>
) {
  sdk = spec;
  spec = sdk;
}
function checkImplementation(
  sdk: SDKTypes.Implementation,
  spec: DeepKnownKeys<SpecTypes.Implementation>
) {
  sdk = spec;
  spec = sdk;
} 
function checkProgressNotification(
  sdk: SDKTypes.ProgressNotification,
  spec: DeepKnownKeys<SpecTypes.ProgressNotification>
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
  sdk: SDKTypes.ListRootsResult,
  spec: DeepKnownKeys<SpecTypes.ListRootsResult>
) {
  sdk = spec;
  spec = sdk;
}
function checkRoot(sdk: SDKTypes.Root, spec: DeepKnownKeys<SpecTypes.Root>) {
  sdk = spec;
  spec = sdk;
}
function checkElicitRequest(sdk: SDKTypes.ElicitRequest, spec: DeepKnownKeys<SpecTypes.ElicitRequest>) {
  sdk = spec;
  spec = sdk;
}
function checkElicitResult(sdk: SDKTypes.ElicitResult, spec: DeepKnownKeys<SpecTypes.ElicitResult>) {
  sdk = spec;
  spec = sdk;
}
function checkCompleteRequest(sdk: SDKTypes.CompleteRequest, spec: DeepKnownKeys<SpecTypes.CompleteRequest>) {
  sdk = spec;
  spec = sdk;
}
function checkCompleteResult(sdk: SDKTypes.CompleteResult, spec: SpecTypes.CompleteResult) {
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
function checkCursor(sdk: SDKTypes.Cursor, spec: SpecTypes.Cursor) {
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
  sdk: SDKTypes.ResourceTemplateReference,
  spec: DeepKnownKeys<SpecTypes.ResourceTemplateReference>
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptReference(
  sdk: SDKTypes.PromptReference,
  spec: DeepKnownKeys<SpecTypes.PromptReference>
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceReference(
  sdk: SDKTypes.ResourceReference,
  spec: DeepKnownKeys<SpecTypes.ResourceTemplateReference>
) {
  sdk = spec;
  spec = sdk;
}
function checkToolAnnotations(
  sdk: SDKTypes.ToolAnnotations,
  spec: DeepKnownKeys<SpecTypes.ToolAnnotations>
) {
  sdk = spec;
  spec = sdk;
}
function checkTool(
  sdk: SDKTypes.Tool,
  spec: DeepKnownKeys<SpecTypes.Tool>
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
  sdk: SDKTypes.ListToolsResult,
  spec: DeepKnownKeys<SpecTypes.ListToolsResult>
) {
  sdk = spec;
  spec = sdk;
}
function checkCallToolResult(
  sdk: SDKTypes.CallToolResult,
  spec: DeepKnownKeys<SpecTypes.CallToolResult>
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
  sdk: SDKTypes.SamplingMessage,
  spec: DeepKnownKeys<SpecTypes.SamplingMessage>
) {
  sdk = spec;
  spec = sdk;
}
function checkCreateMessageResult(
  sdk: SDKTypes.CreateMessageResult,
  spec: DeepKnownKeys<SpecTypes.CreateMessageResult>
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
  sdk: SDKTypes.ListResourcesResult,
  spec: DeepKnownKeys<SpecTypes.ListResourcesResult>
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
  sdk: SDKTypes.ListResourceTemplatesResult,
  spec: DeepKnownKeys<SpecTypes.ListResourceTemplatesResult>
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
  sdk: SDKTypes.ReadResourceResult,
  spec: DeepKnownKeys<SpecTypes.ReadResourceResult>
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceContents(
  sdk: SDKTypes.ResourceContents,
  spec: DeepKnownKeys<SpecTypes.ResourceContents>
) {
  sdk = spec;
  spec = sdk;
}
function checkTextResourceContents(
  sdk: SDKTypes.TextResourceContents,
  spec: DeepKnownKeys<SpecTypes.TextResourceContents>
) {
  sdk = spec;
  spec = sdk;
}
function checkBlobResourceContents(
  sdk: SDKTypes.BlobResourceContents,
  spec: DeepKnownKeys<SpecTypes.BlobResourceContents>
) {
  sdk = spec;
  spec = sdk;
}
function checkResource(
  sdk: SDKTypes.Resource,
  spec: DeepKnownKeys<SpecTypes.Resource>
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceTemplate(
  sdk: SDKTypes.ResourceTemplate,
  spec: DeepKnownKeys<SpecTypes.ResourceTemplate>
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptArgument(
  sdk: SDKTypes.PromptArgument,
  spec: DeepKnownKeys<SpecTypes.PromptArgument>
) {
  sdk = spec;
  spec = sdk;
}
function checkPrompt(
  sdk: SDKTypes.Prompt,
  spec: DeepKnownKeys<SpecTypes.Prompt>
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
  sdk: SDKTypes.ListPromptsResult,
  spec: DeepKnownKeys<SpecTypes.ListPromptsResult>
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
  sdk: SDKTypes.TextContent,
  spec: DeepKnownKeys<SpecTypes.TextContent>
) {
  sdk = spec;
  spec = sdk;
}
function checkImageContent(
  sdk: SDKTypes.ImageContent,
  spec: DeepKnownKeys<SpecTypes.ImageContent>
) {
  sdk = spec;
  spec = sdk;
}
function checkAudioContent(
  sdk: SDKTypes.AudioContent,
  spec: DeepKnownKeys<SpecTypes.AudioContent>
) {
  sdk = spec;
  spec = sdk;
}
function checkEmbeddedResource(
  sdk: SDKTypes.EmbeddedResource,
  spec: DeepKnownKeys<SpecTypes.EmbeddedResource>
) {
  sdk = spec;
  spec = sdk;
}
function checkResourceLink(
  sdk: SDKTypes.ResourceLink,
  spec: DeepKnownKeys<SpecTypes.ResourceLink>
) {
  sdk = spec;
  spec = sdk;
}
function checkContentBlock(
  sdk: SDKTypes.ContentBlock,
  spec: DeepKnownKeys<SpecTypes.ContentBlock>
) {
  sdk = spec;
  spec = sdk;
}
function checkPromptMessage(
  sdk: SDKTypes.PromptMessage,
  spec: DeepKnownKeys<SpecTypes.PromptMessage>
) {
  sdk = spec;
  spec = sdk;
}
function checkGetPromptResult(
  sdk: SDKTypes.GetPromptResult,
  spec: DeepKnownKeys<SpecTypes.GetPromptResult>
) {
  sdk = spec;
  spec = sdk;
}
function checkBooleanSchema(
  sdk: SDKTypes.BooleanSchema,
  spec: DeepKnownKeys<SpecTypes.BooleanSchema>
) {
  sdk = spec;
  spec = sdk;
}
function checkStringSchema(
  sdk: SDKTypes.StringSchema,
  spec: DeepKnownKeys<SpecTypes.StringSchema>
) {
  sdk = spec;
  spec = sdk;
}
function checkNumberSchema(
  sdk: SDKTypes.NumberSchema,
  spec: DeepKnownKeys<SpecTypes.NumberSchema>
) {
  sdk = spec;
  spec = sdk;
}
function checkEnumSchema(
  sdk: SDKTypes.EnumSchema,
  spec: DeepKnownKeys<SpecTypes.EnumSchema>
) {
  sdk = spec;
  spec = sdk;
}
function checkPrimitiveSchemaDefinition(
  sdk: SDKTypes.PrimitiveSchemaDefinition,
  spec: DeepKnownKeys<SpecTypes.PrimitiveSchemaDefinition>
) {
  sdk = spec;
  spec = sdk;
}
function checkCreateMessageRequest(
  sdk: DeepKnownKeys<SDKTypes.CreateMessageRequest>, // TODO(quirk): some {} type
  spec: DeepKnownKeys<SpecTypes.CreateMessageRequest>
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializeRequest(
  sdk: DeepKnownKeys<SDKTypes.InitializeRequest>, // TODO(quirk): some {} type
  spec: SpecTypes.InitializeRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkInitializeResult(
  sdk: DeepKnownKeys<SDKTypes.InitializeResult>, // TODO(quirk): some {} type
  spec: SpecTypes.InitializeResult
) {
  sdk = spec;
  spec = sdk;
}
function checkClientCapabilities(
  sdk: DeepKnownKeys<SDKTypes.ClientCapabilities>, // TODO(quirk): {}
  spec: SpecTypes.ClientCapabilities
) {
  sdk = spec;
  spec = sdk;
}
function checkServerCapabilities(
  sdk: DeepKnownKeys<SDKTypes.ServerCapabilities>, // TODO(quirk): {}
  spec: SpecTypes.ServerCapabilities
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCError(
  sdk: DeepKnownKeys<SDKTypes.JSONRPCError>, // TODO(quirk): error.data
  spec: DeepKnownKeys<SpecTypes.JSONRPCError>
) {
  sdk = spec;
  spec = sdk;
}
function checkJSONRPCMessage(
  sdk: DeepKnownKeys<SDKTypes.JSONRPCMessage>, // TODO(quirk): error.data
  spec: DeepKnownKeys<SpecTypes.JSONRPCMessage>
) {
  sdk = spec;
  spec = sdk;
}
function checkClientRequest(
  sdk: DeepKnownKeys<SDKTypes.ClientRequest>, // TODO(quirk): capabilities.logging is {}
  spec: SpecTypes.ClientRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkServerRequest(
  sdk: DeepKnownKeys<SDKTypes.ServerRequest>, // TODO(quirk): some {} typ
  spec: SpecTypes.ServerRequest
) {
  sdk = spec;
  spec = sdk;
}
function checkLoggingMessageNotification(
  sdk: SDKTypes.LoggingMessageNotification,
  spec: SpecTypes.LoggingMessageNotification
) {
  sdk = spec;
  // spec = sdk; // TODO(bug): data is optional
}
function checkServerNotification(
  sdk: SDKTypes.ServerNotification,
  spec: SpecTypes.ServerNotification
) {
  sdk = spec;
  // spec = sdk; // TODO(bug): data is optional
}

// TODO(bug): missing type in SDK
// function checkModelHint(
//   sdk: SDKTypes.ModelHint,
//   spec: DeepKnownKeys<SpecTypes.ModelHint>
// ) {
//   sdk = spec;
//   spec = sdk;
// }

// TODO(bug): missing type in SDK
// function checkModelPreferences(
//   sdk: SDKTypes.ModelPreferences,
//   spec: DeepKnownKeys<SpecTypes.ModelPreferences>
// ) {
//   sdk = spec;
//   spec = sdk;
// }

// TODO(bug): missing type in SDK
// function checkAnnotations(
//   sdk: SDKTypes.Annotations,
//   spec: DeepKnownKeys<SpecTypes.Annotations>
// ) {
//   sdk = spec;
//   spec = sdk;
// }

const SPEC_TYPES_FILE  = 'src/spec.types.ts';
const THIS_SOURCE_FILE = 'src/spec.types.test.ts';

describe('Spec Types', () => {
    const specTypesContent = require('fs').readFileSync(SPEC_TYPES_FILE, 'utf-8');
    const typeNames = [...specTypesContent.matchAll(/export\s+interface\s+(\w+)\b/g)].map(m => m[1]);
    const testContent = require('fs').readFileSync(THIS_SOURCE_FILE, 'utf-8');
    
    it('should define some expected types', () => {
        expect(typeNames).toContain('JSONRPCNotification');
        expect(typeNames).toContain('ElicitResult');
    });

    for (const typeName of typeNames) {
        it(`${typeName} should have a compatibility test`, () => {
            expect(testContent).toContain(`function check${typeName}(`);
        });
    }
});