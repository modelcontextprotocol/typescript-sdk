/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the SDK's types
 *   (mutually assignable, w/ slight affordances to get rid of ZodObject.passthrough() index signatures, etc)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import * as SpecTypes from "./spec.types.js";
import fs from "node:fs";
import { z } from "zod";

import * as Schemas from "./schemas.js";


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
type WithJSONRPCRequest<T> = T & { jsonrpc: '2.0'; id: z.infer<typeof Schemas.RequestIdSchema> };

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
  CancelledNotification: (
    specType: SpecTypes.CancelledNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.CancelledNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  BaseMetadata: (
    specType: SpecTypes.BaseMetadata,
    inferredType: z.infer<typeof Schemas.BaseMetadataSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Implementation: (
    specType: SpecTypes.Implementation,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ImplementationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ProgressNotification: (
    specType: SpecTypes.ProgressNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.ProgressNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  SubscribeRequest: (
    specType: SpecTypes.SubscribeRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.SubscribeRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  UnsubscribeRequest: (
    specType: SpecTypes.UnsubscribeRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.UnsubscribeRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PaginatedRequest: (
    specType: SpecTypes.PaginatedRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.PaginatedRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PaginatedResult: (
    specType: SpecTypes.PaginatedResult,
    inferredType: z.infer<typeof Schemas.PaginatedResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListRootsRequest: (
    specType: SpecTypes.ListRootsRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ListRootsRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListRootsResult: (
    specType: SpecTypes.ListRootsResult,
    inferredType: z.infer<typeof Schemas.ListRootsResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Root: (
    specType: SpecTypes.Root,
    inferredType: z.infer<typeof Schemas.RootSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ElicitRequest: (
    specType: SpecTypes.ElicitRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ElicitRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ElicitResult: (
    specType: SpecTypes.ElicitResult,
    inferredType: z.infer<typeof Schemas.ElicitResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CompleteRequest: (
    specType: SpecTypes.CompleteRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.CompleteRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CompleteResult: (
    specType: SpecTypes.CompleteResult,
    inferredType: z.infer<typeof Schemas.CompleteResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ProgressToken: (
    specType: SpecTypes.ProgressToken,
    inferredType: z.infer<typeof Schemas.ProgressTokenSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Cursor: (
    specType: SpecTypes.Cursor,
    inferredType: z.infer<typeof Schemas.CursorSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Request: (
    specType: SpecTypes.Request,
    inferredType: z.infer<typeof Schemas.RequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Result: (
    specType: SpecTypes.Result,
    inferredType: z.infer<typeof Schemas.ResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  RequestId: (
    specType: SpecTypes.RequestId,
    inferredType: z.infer<typeof Schemas.RequestIdSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCRequest: (
    specType: SpecTypes.JSONRPCRequest,
    inferredType: z.infer<typeof Schemas.JSONRPCRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCNotification: (
    specType: SpecTypes.JSONRPCNotification,
    inferredType: z.infer<typeof Schemas.JSONRPCNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCResponse: (
    specType: SpecTypes.JSONRPCResponse,
    inferredType: z.infer<typeof Schemas.JSONRPCResponseSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  EmptyResult: (
    specType: SpecTypes.EmptyResult,
    inferredType: z.infer<typeof Schemas.EmptyResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Notification: (
    specType: SpecTypes.Notification,
    inferredType: z.infer<typeof Schemas.NotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientResult: (
    specType: SpecTypes.ClientResult,
    inferredType: z.infer<typeof Schemas.ClientResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientNotification: (
    specType: SpecTypes.ClientNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.ClientNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerResult: (
    specType: SpecTypes.ServerResult,
    inferredType: z.infer<typeof Schemas.ServerResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceTemplateReference: (
    specType: SpecTypes.ResourceTemplateReference,
    inferredType: z.infer<typeof Schemas.ResourceTemplateReferenceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptReference: (
    specType: SpecTypes.PromptReference,
    inferredType: z.infer<typeof Schemas.PromptReferenceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ToolAnnotations: (
    specType: SpecTypes.ToolAnnotations,
    inferredType: z.infer<typeof Schemas.ToolAnnotationsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Tool: (
    specType: SpecTypes.Tool,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ToolSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListToolsRequest: (
    specType: SpecTypes.ListToolsRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ListToolsRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListToolsResult: (
    specType: SpecTypes.ListToolsResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ListToolsResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CallToolResult: (
    specType: SpecTypes.CallToolResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.CallToolResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CallToolRequest: (
    specType: SpecTypes.CallToolRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.CallToolRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ToolListChangedNotification: (
    specType: SpecTypes.ToolListChangedNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.ToolListChangedNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceListChangedNotification: (
    specType: SpecTypes.ResourceListChangedNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.ResourceListChangedNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptListChangedNotification: (
    specType: SpecTypes.PromptListChangedNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.PromptListChangedNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  RootsListChangedNotification: (
    specType: SpecTypes.RootsListChangedNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.RootsListChangedNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceUpdatedNotification: (
    specType: SpecTypes.ResourceUpdatedNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.ResourceUpdatedNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  SamplingMessage: (
    specType: SpecTypes.SamplingMessage,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.SamplingMessageSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CreateMessageResult: (
    specType: SpecTypes.CreateMessageResult,
    inferredType: z.infer<typeof Schemas.CreateMessageResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  SetLevelRequest: (
    specType: SpecTypes.SetLevelRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.SetLevelRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PingRequest: (
    specType: SpecTypes.PingRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.PingRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  InitializedNotification: (
    specType: SpecTypes.InitializedNotification,
    inferredType: WithJSONRPC<z.infer<typeof Schemas.InitializedNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourcesRequest: (
    specType: SpecTypes.ListResourcesRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ListResourcesRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourcesResult: (
    specType: SpecTypes.ListResourcesResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ListResourcesResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourceTemplatesRequest: (
    specType: SpecTypes.ListResourceTemplatesRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ListResourceTemplatesRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourceTemplatesResult: (
    specType: SpecTypes.ListResourceTemplatesResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ListResourceTemplatesResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ReadResourceRequest: (
    specType: SpecTypes.ReadResourceRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ReadResourceRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ReadResourceResult: (
    specType: SpecTypes.ReadResourceResult,
    inferredType: z.infer<typeof Schemas.ReadResourceResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceContents: (
    specType: SpecTypes.ResourceContents,
    inferredType: z.infer<typeof Schemas.ResourceContentsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  TextResourceContents: (
    specType: SpecTypes.TextResourceContents,
    inferredType: z.infer<typeof Schemas.TextResourceContentsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  BlobResourceContents: (
    specType: SpecTypes.BlobResourceContents,
    inferredType: z.infer<typeof Schemas.BlobResourceContentsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Resource: (
    specType: SpecTypes.Resource,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ResourceSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceTemplate: (
    specType: SpecTypes.ResourceTemplate,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ResourceTemplateSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptArgument: (
    specType: SpecTypes.PromptArgument,
    inferredType: z.infer<typeof Schemas.PromptArgumentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Prompt: (
    specType: SpecTypes.Prompt,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.PromptSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListPromptsRequest: (
    specType: SpecTypes.ListPromptsRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.ListPromptsRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListPromptsResult: (
    specType: SpecTypes.ListPromptsResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ListPromptsResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  GetPromptRequest: (
    specType: SpecTypes.GetPromptRequest,
    inferredType: WithJSONRPCRequest<z.infer<typeof Schemas.GetPromptRequestSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  TextContent: (
    specType: SpecTypes.TextContent,
    inferredType: z.infer<typeof Schemas.TextContentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ImageContent: (
    specType: SpecTypes.ImageContent,
    inferredType: z.infer<typeof Schemas.ImageContentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  AudioContent: (
    specType: SpecTypes.AudioContent,
    inferredType: z.infer<typeof Schemas.AudioContentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  EmbeddedResource: (
    specType: SpecTypes.EmbeddedResource,
    inferredType: z.infer<typeof Schemas.EmbeddedResourceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceLink: (
    specType: SpecTypes.ResourceLink,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ResourceLinkSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ContentBlock: (
    specType: SpecTypes.ContentBlock,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ContentBlockSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptMessage: (
    specType: SpecTypes.PromptMessage,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.PromptMessageSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  GetPromptResult: (
    specType: SpecTypes.GetPromptResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.GetPromptResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  BooleanSchema: (
    specType: SpecTypes.BooleanSchema,
    inferredType: z.infer<typeof Schemas.BooleanSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  StringSchema: (
    specType: SpecTypes.StringSchema,
    inferredType: z.infer<typeof Schemas.StringSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  NumberSchema: (
    specType: SpecTypes.NumberSchema,
    inferredType: z.infer<typeof Schemas.NumberSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  EnumSchema: (
    specType: SpecTypes.EnumSchema,
    inferredType: z.infer<typeof Schemas.EnumSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PrimitiveSchemaDefinition: (
    specType: SpecTypes.PrimitiveSchemaDefinition,
    inferredType: z.infer<typeof Schemas.PrimitiveSchemaDefinitionSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCError: (
    specType: SpecTypes.JSONRPCError,
    inferredType: z.infer<typeof Schemas.JSONRPCErrorSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCMessage: (
    specType: SpecTypes.JSONRPCMessage,
    inferredType: z.infer<typeof Schemas.JSONRPCMessageSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CreateMessageRequest: (
    specType: SpecTypes.CreateMessageRequest,
    inferredType: RemovePassthrough<WithJSONRPCRequest<z.infer<typeof Schemas.CreateMessageRequestSchema>>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  InitializeRequest: (
    specType: SpecTypes.InitializeRequest,
    inferredType: RemovePassthrough<WithJSONRPCRequest<z.infer<typeof Schemas.InitializeRequestSchema>>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  InitializeResult: (
    specType: SpecTypes.InitializeResult,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.InitializeResultSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientCapabilities: (
    specType: SpecTypes.ClientCapabilities,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.ClientCapabilitiesSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerCapabilities: (
    specType: SpecTypes.ServerCapabilities,
    inferredType: z.infer<typeof Schemas.ServerCapabilitiesSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientRequest: (
    specType: SpecTypes.ClientRequest,
    inferredType: RemovePassthrough<WithJSONRPCRequest<z.infer<typeof Schemas.ClientRequestSchema>>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerRequest: (
    specType: SpecTypes.ServerRequest,
    inferredType: RemovePassthrough<WithJSONRPCRequest<z.infer<typeof Schemas.ServerRequestSchema>>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  LoggingMessageNotification: (
    specType: SpecTypes.LoggingMessageNotification,
    inferredType: MakeUnknownsNotOptional<WithJSONRPC<z.infer<typeof Schemas.LoggingMessageNotificationSchema>>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerNotification: (
    specType: SpecTypes.ServerNotification,
    inferredType: MakeUnknownsNotOptional<WithJSONRPC<z.infer<typeof Schemas.ServerNotificationSchema>>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  LoggingLevel: (
    specType: SpecTypes.LoggingLevel,
    inferredType: z.infer<typeof Schemas.LoggingLevelSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Icon: (
    specType: SpecTypes.Icon,
    inferredType: z.infer<typeof Schemas.IconSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Icons: (
    specType: SpecTypes.Icons,
    inferredType: RemovePassthrough<z.infer<typeof Schemas.IconsSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
};

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE = "spec.types.ts";
const SDK_TYPES_FILE = "src/types.ts";

const MISSING_SDK_TYPES = [
  // These are inlined in the SDK:
  "Role",
  "Error", // The inner error object of a JSONRPCError

  // These aren't supported by the SDK yet:
  // TODO: Add definitions to the SDK
  "Annotations",
  "ModelHint",
  "ModelPreferences",
];

function extractExportedTypes(source: string): string[] {
  return [
    ...source.matchAll(/export\s+(?:interface|class|type)\s+(\w+)\b/g),
  ].map((m) => m[1]);
}

describe("Spec Types", () => {
  const specTypes = extractExportedTypes(
    fs.readFileSync(SPEC_TYPES_FILE, "utf-8")
  );
  const sdkTypes = extractExportedTypes(
    fs.readFileSync(SDK_TYPES_FILE, "utf-8")
  );
  const typesToCheck = specTypes.filter(
    (type) => !MISSING_SDK_TYPES.includes(type)
  );

  it("should define some expected types", () => {
    expect(specTypes).toContain("JSONRPCNotification");
    expect(specTypes).toContain("ElicitResult");
    expect(specTypes).toHaveLength(94);
  });

  it("should have up to date list of missing sdk types", () => {
    for (const typeName of MISSING_SDK_TYPES) {
      expect(sdkTypes).not.toContain(typeName);
    }
  });

  describe("Compatibility tests", () => {
    it.each(typesToCheck)("%s should have a compatibility test", (type) => {
      expect(sdkTypeChecks[type as keyof typeof sdkTypeChecks]).toBeDefined();
    });
  });

  describe("Missing SDK Types", () => {
    it.each(MISSING_SDK_TYPES)(
      "%s should not be present in MISSING_SDK_TYPES if it has a compatibility test",
      (type) => {
        expect(
          sdkTypeChecks[type as keyof typeof sdkTypeChecks]
        ).toBeUndefined();
      }
    );
  });
});
