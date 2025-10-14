/**
 * This contains:
 * - Static type checks to verify the Spec's types are compatible with the types derived from the SDK's zod schemas
 *   (mutually assignable, w/ slight affordances to get rid of ZodObject.passthrough() index signatures, etc)
 * - Runtime checks to verify each Spec type has a static check
 *   (note: a few don't have SDK types, see MISSING_SDK_TYPES below)
 */
import fs from "node:fs";
import { z, ZodTypeAny } from "zod";

import {
  type CancelledNotification,
  type BaseMetadata,
  type Implementation,
  type ProgressNotification,
  type SubscribeRequest,
  type UnsubscribeRequest,
  type PaginatedRequest,
  type PaginatedResult,
  type ListRootsRequest,
  type ListRootsResult,
  type Root,
  type ElicitRequest,
  type ElicitResult,
  type CompleteRequest,
  type CompleteResult,
  type ProgressToken,
  type Cursor,
  type Request,
  type Result,
  type RequestId,
  type JSONRPCRequest,
  type JSONRPCNotification,
  type JSONRPCResponse,
  type EmptyResult,
  type Notification,
  type ClientResult,
  type ClientNotification,
  type ServerResult,
  type ResourceTemplateReference,
  type PromptReference,
  type ToolAnnotations,
  type Tool,
  type ListToolsRequest,
  type ListToolsResult,
  type CallToolResult,
  type CallToolRequest,
  type ToolListChangedNotification,
  type ResourceListChangedNotification,
  type PromptListChangedNotification,
  type RootsListChangedNotification,
  type ResourceUpdatedNotification,
  type SamplingMessage,
  type CreateMessageResult,
  type SetLevelRequest,
  type PingRequest,
  type InitializedNotification,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ListResourceTemplatesRequest,
  type ListResourceTemplatesResult,
  type ReadResourceRequest,
  type ReadResourceResult,
  type ResourceContents,
  type TextResourceContents,
  type BlobResourceContents,
  type Resource,
  type ResourceTemplate,
  type PromptArgument,
  type Prompt,
  type ListPromptsRequest,
  type ListPromptsResult,
  type GetPromptRequest,
  type TextContent,
  type ImageContent,
  type AudioContent,
  type EmbeddedResource,
  type ResourceLink,
  type ContentBlock,
  type PromptMessage,
  type GetPromptResult,
  type BooleanSchema,
  type StringSchema,
  type NumberSchema,
  type EnumSchema,
  type PrimitiveSchemaDefinition,
  type JSONRPCError,
  type JSONRPCMessage,
  type CreateMessageRequest,
  type InitializeRequest,
  type InitializeResult,
  type ClientCapabilities,
  type ServerCapabilities,
  type ClientRequest,
  type ServerRequest,
  type LoggingMessageNotification,
  type ServerNotification,
  type LoggingLevel,
  type Icon,
  type Icons,
} from "./types.js";
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

type Infer<Schema extends ZodTypeAny> = RemovePassthrough<z.infer<Schema>>;

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
    specType: CancelledNotification,
    inferredType: Infer<typeof Schemas.CancelledNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  BaseMetadata: (
    specType: BaseMetadata,
    inferredType: Infer<typeof Schemas.BaseMetadataSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Implementation: (
    specType: Implementation,
    inferredType: Infer<typeof Schemas.ImplementationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ProgressNotification: (
    specType: ProgressNotification,
    inferredType: Infer<typeof Schemas.ProgressNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  SubscribeRequest: (
    specType: SubscribeRequest,
    inferredType: Infer<typeof Schemas.SubscribeRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  UnsubscribeRequest: (
    specType: UnsubscribeRequest,
    inferredType: Infer<typeof Schemas.UnsubscribeRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PaginatedRequest: (
    specType: PaginatedRequest,
    inferredType: Infer<typeof Schemas.PaginatedRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PaginatedResult: (
    specType: PaginatedResult,
    inferredType: Infer<typeof Schemas.PaginatedResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListRootsRequest: (
    specType: ListRootsRequest,
    inferredType: Infer<typeof Schemas.ListRootsRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListRootsResult: (
    specType: ListRootsResult,
    inferredType: Infer<typeof Schemas.ListRootsResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Root: (
    specType: Root,
    inferredType: Infer<typeof Schemas.RootSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ElicitRequest: (
    specType: ElicitRequest,
    inferredType: Infer<typeof Schemas.ElicitRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ElicitResult: (
    specType: ElicitResult,
    inferredType: Infer<typeof Schemas.ElicitResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CompleteRequest: (
    specType: CompleteRequest,
    inferredType: Infer<typeof Schemas.CompleteRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CompleteResult: (
    specType: CompleteResult,
    inferredType: Infer<typeof Schemas.CompleteResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ProgressToken: (
    specType: ProgressToken,
    inferredType: Infer<typeof Schemas.ProgressTokenSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Cursor: (
    specType: Cursor,
    inferredType: Infer<typeof Schemas.CursorSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Request: (
    specType: Request,
    inferredType: Infer<typeof Schemas.RequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Result: (
    specType: Result,
    inferredType: Infer<typeof Schemas.ResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  RequestId: (
    specType: RequestId,
    inferredType: Infer<typeof Schemas.RequestIdSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCRequest: (
    specType: JSONRPCRequest,
    inferredType: Infer<typeof Schemas.JSONRPCRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCNotification: (
    specType: JSONRPCNotification,
    inferredType: Infer<typeof Schemas.JSONRPCNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCResponse: (
    specType: JSONRPCResponse,
    inferredType: Infer<typeof Schemas.JSONRPCResponseSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  EmptyResult: (
    specType: EmptyResult,
    inferredType: Infer<typeof Schemas.EmptyResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Notification: (
    specType: Notification,
    inferredType: Infer<typeof Schemas.NotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientResult: (
    specType: ClientResult,
    inferredType: Infer<typeof Schemas.ClientResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientNotification: (
    specType: ClientNotification,
    inferredType: Infer<typeof Schemas.ClientNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerResult: (
    specType: ServerResult,
    inferredType: Infer<typeof Schemas.ServerResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceTemplateReference: (
    specType: ResourceTemplateReference,
    inferredType: Infer<typeof Schemas.ResourceTemplateReferenceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptReference: (
    specType: PromptReference,
    inferredType: Infer<typeof Schemas.PromptReferenceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ToolAnnotations: (
    specType: ToolAnnotations,
    inferredType: Infer<typeof Schemas.ToolAnnotationsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Tool: (
    specType: Tool,
    inferredType: Infer<typeof Schemas.ToolSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListToolsRequest: (
    specType: ListToolsRequest,
    inferredType: Infer<typeof Schemas.ListToolsRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListToolsResult: (
    specType: ListToolsResult,
    inferredType: Infer<typeof Schemas.ListToolsResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CallToolResult: (
    specType: CallToolResult,
    inferredType: Infer<typeof Schemas.CallToolResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CallToolRequest: (
    specType: CallToolRequest,
    inferredType: Infer<typeof Schemas.CallToolRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ToolListChangedNotification: (
    specType: ToolListChangedNotification,
    inferredType: Infer<typeof Schemas.ToolListChangedNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceListChangedNotification: (
    specType: ResourceListChangedNotification,
    inferredType: Infer<typeof Schemas.ResourceListChangedNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptListChangedNotification: (
    specType: PromptListChangedNotification,
    inferredType: Infer<typeof Schemas.PromptListChangedNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  RootsListChangedNotification: (
    specType: RootsListChangedNotification,
    inferredType: Infer<typeof Schemas.RootsListChangedNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceUpdatedNotification: (
    specType: ResourceUpdatedNotification,
    inferredType: Infer<typeof Schemas.ResourceUpdatedNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  SamplingMessage: (
    specType: SamplingMessage,
    inferredType: Infer<typeof Schemas.SamplingMessageSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CreateMessageResult: (
    specType: CreateMessageResult,
    inferredType: Infer<typeof Schemas.CreateMessageResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  SetLevelRequest: (
    specType: SetLevelRequest,
    inferredType: Infer<typeof Schemas.SetLevelRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PingRequest: (
    specType: PingRequest,
    inferredType: Infer<typeof Schemas.PingRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  InitializedNotification: (
    specType: InitializedNotification,
    inferredType: Infer<typeof Schemas.InitializedNotificationSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourcesRequest: (
    specType: ListResourcesRequest,
    inferredType: Infer<typeof Schemas.ListResourcesRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourcesResult: (
    specType: ListResourcesResult,
    inferredType: Infer<typeof Schemas.ListResourcesResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourceTemplatesRequest: (
    specType: ListResourceTemplatesRequest,
    inferredType: Infer<typeof Schemas.ListResourceTemplatesRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListResourceTemplatesResult: (
    specType: ListResourceTemplatesResult,
    inferredType: Infer<typeof Schemas.ListResourceTemplatesResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ReadResourceRequest: (
    specType: ReadResourceRequest,
    inferredType: Infer<typeof Schemas.ReadResourceRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ReadResourceResult: (
    specType: ReadResourceResult,
    inferredType: Infer<typeof Schemas.ReadResourceResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceContents: (
    specType: ResourceContents,
    inferredType: Infer<typeof Schemas.ResourceContentsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  TextResourceContents: (
    specType: TextResourceContents,
    inferredType: Infer<typeof Schemas.TextResourceContentsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  BlobResourceContents: (
    specType: BlobResourceContents,
    inferredType: Infer<typeof Schemas.BlobResourceContentsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Resource: (
    specType: Resource,
    inferredType: Infer<typeof Schemas.ResourceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceTemplate: (
    specType: ResourceTemplate,
    inferredType: Infer<typeof Schemas.ResourceTemplateSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptArgument: (
    specType: PromptArgument,
    inferredType: Infer<typeof Schemas.PromptArgumentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Prompt: (
    specType: Prompt,
    inferredType: Infer<typeof Schemas.PromptSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListPromptsRequest: (
    specType: ListPromptsRequest,
    inferredType: Infer<typeof Schemas.ListPromptsRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ListPromptsResult: (
    specType: ListPromptsResult,
    inferredType: Infer<typeof Schemas.ListPromptsResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  GetPromptRequest: (
    specType: GetPromptRequest,
    inferredType: Infer<typeof Schemas.GetPromptRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  TextContent: (
    specType: TextContent,
    inferredType: Infer<typeof Schemas.TextContentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ImageContent: (
    specType: ImageContent,
    inferredType: Infer<typeof Schemas.ImageContentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  AudioContent: (
    specType: AudioContent,
    inferredType: Infer<typeof Schemas.AudioContentSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  EmbeddedResource: (
    specType: EmbeddedResource,
    inferredType: Infer<typeof Schemas.EmbeddedResourceSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ResourceLink: (
    specType: ResourceLink,
    inferredType: Infer<typeof Schemas.ResourceLinkSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ContentBlock: (
    specType: ContentBlock,
    inferredType: Infer<typeof Schemas.ContentBlockSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PromptMessage: (
    specType: PromptMessage,
    inferredType: Infer<typeof Schemas.PromptMessageSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  GetPromptResult: (
    specType: GetPromptResult,
    inferredType: Infer<typeof Schemas.GetPromptResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  BooleanSchema: (
    specType: BooleanSchema,
    inferredType: Infer<typeof Schemas.BooleanSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  StringSchema: (
    specType: StringSchema,
    inferredType: Infer<typeof Schemas.StringSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  NumberSchema: (
    specType: NumberSchema,
    inferredType: Infer<typeof Schemas.NumberSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  EnumSchema: (
    specType: EnumSchema,
    inferredType: Infer<typeof Schemas.EnumSchemaSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  PrimitiveSchemaDefinition: (
    specType: PrimitiveSchemaDefinition,
    inferredType: Infer<typeof Schemas.PrimitiveSchemaDefinitionSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCError: (
    specType: JSONRPCError,
    inferredType: Infer<typeof Schemas.JSONRPCErrorSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  JSONRPCMessage: (
    specType: JSONRPCMessage,
    inferredType: Infer<typeof Schemas.JSONRPCMessageSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  CreateMessageRequest: (
    specType: CreateMessageRequest,
    inferredType: Infer<typeof Schemas.CreateMessageRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  InitializeRequest: (
    specType: InitializeRequest,
    inferredType: Infer<typeof Schemas.InitializeRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  InitializeResult: (
    specType: InitializeResult,
    inferredType: Infer<typeof Schemas.InitializeResultSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientCapabilities: (
    specType: ClientCapabilities,
    inferredType: Infer<typeof Schemas.ClientCapabilitiesSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerCapabilities: (
    specType: ServerCapabilities,
    inferredType: Infer<typeof Schemas.ServerCapabilitiesSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ClientRequest: (
    specType: ClientRequest,
    inferredType: Infer<typeof Schemas.ClientRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerRequest: (
    specType: ServerRequest,
    inferredType: Infer<typeof Schemas.ServerRequestSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  LoggingMessageNotification: (
    specType: LoggingMessageNotification,
    inferredType: MakeUnknownsNotOptional<Infer<typeof Schemas.LoggingMessageNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  ServerNotification: (
    specType: ServerNotification,
    inferredType: MakeUnknownsNotOptional<Infer<typeof Schemas.ServerNotificationSchema>>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  LoggingLevel: (
    specType: LoggingLevel,
    inferredType: Infer<typeof Schemas.LoggingLevelSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Icon: (
    specType: Icon,
    inferredType: Infer<typeof Schemas.IconSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
  Icons: (
    specType: Icons,
    inferredType: Infer<typeof Schemas.IconsSchema>,
  ) => {
    inferredType = specType;
    specType = inferredType;
  },
};

// This file is .gitignore'd, and fetched by `npm run fetch:spec-types` (called by `npm run test`)
const SPEC_TYPES_FILE = "src/spec.types.ts";
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
