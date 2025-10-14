import { AuthInfo } from "./server/auth/types.js";
import { z } from "zod";

import * as Spec from "./spec.types.js";
export { 

  type AudioContent, 
  type BaseMetadata, 
  type BlobResourceContents, 
  type BooleanSchema, 
  type CallToolResult,   
  type ClientCapabilities,  
  type CompleteResult, 
  type ContentBlock, 
  type CreateMessageResult, 
  type Cursor,   
  type ElicitResult, 
  type EmbeddedResource, 
  type EmptyResult,  
  type EnumSchema, 
  type GetPromptResult,  
  type Icon, 
  type Icons, 
  type ImageContent, 
  type Implementation, 
  type InitializeResult,     
  type JSONRPCError,
  type JSONRPCMessage, 
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResponse, 
  type ListPromptsResult,  
  type ListResourcesResult,  
  type ListResourceTemplatesResult,  
  type ListRootsResult, 
  type ListToolsResult, 
  type LoggingLevel,   
  type NumberSchema, 
  type PaginatedResult, 
  type PrimitiveSchemaDefinition,  
  type ProgressToken, 
  type Prompt,  
  type PromptArgument, 
  type PromptMessage, 
  type PromptReference,  
  type ReadResourceResult,     
  type RequestId,    
  type Resource, 
  type ResourceContents, 
  type ResourceLink, 
  type ResourceTemplate,  
  type ResourceTemplateReference, 
  type Result, 
  type Root,  
  type SamplingMessage,  
  type ServerCapabilities, 
  type StringSchema, 
  type TextContent, 
  type TextResourceContents, 
  type Tool,  
  type ToolAnnotations, 
} from "./spec.types.js";

// Schema re-exports for backwards compatibility
export {
  isJSONRPCError,
  isJSONRPCResponse,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isInitializeRequest,
  isInitializedNotification,

  ProgressTokenSchema,
  CursorSchema,
  RequestSchema,
  NotificationSchema,
  ResultSchema,
  RequestIdSchema,
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResponseSchema,
  JSONRPCErrorSchema,
  JSONRPCMessageSchema,
  EmptyResultSchema,
  CancelledNotificationSchema,
  IconSchema,
  IconsSchema,
  BaseMetadataSchema,
  ImplementationSchema,
  ClientCapabilitiesSchema,
  InitializeRequestSchema,
  ServerCapabilitiesSchema,
  InitializeResultSchema,
  InitializedNotificationSchema,
  PingRequestSchema,
  ProgressSchema,
  ProgressNotificationSchema,
  PaginatedRequestSchema,
  PaginatedResultSchema,
  ResourceContentsSchema,
  TextResourceContentsSchema,
  BlobResourceContentsSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ResourceUpdatedNotificationSchema,
  PromptArgumentSchema,
  PromptSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  GetPromptRequestSchema,
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ToolCallContentSchema,
  EmbeddedResourceSchema,
  ResourceLinkSchema,
  ContentBlockSchema,
  PromptMessageSchema,
  GetPromptResultSchema,
  PromptListChangedNotificationSchema,
  ToolAnnotationsSchema,
  ToolSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  CallToolRequestSchema,
  ToolListChangedNotificationSchema,
  LoggingLevelSchema,
  SetLevelRequestSchema,
  LoggingMessageNotificationSchema,
  ModelHintSchema,
  ModelPreferencesSchema,
  SamplingMessageSchema,
  CreateMessageRequestSchema,
  CreateMessageResultSchema,
  BooleanSchemaSchema,
  StringSchemaSchema,
  NumberSchemaSchema,
  EnumSchemaSchema,
  PrimitiveSchemaDefinitionSchema,
  ElicitRequestSchema,
  ElicitResultSchema,
  ResourceTemplateReferenceSchema,
  ResourceReferenceSchema,
  PromptReferenceSchema,
  CompleteRequestSchema,
  CompleteResultSchema,
  RootSchema,
  ListRootsRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
  ClientRequestSchema,
  ClientNotificationSchema,
  ClientResultSchema,
  ServerRequestSchema,
  ServerNotificationSchema,
  ServerResultSchema,
} from "./schemas.js";
import { ProgressSchema, RequestMetaSchema } from "./schemas.js";

// For historical reasons the SDK notification + requests types & schemas don't have the jsonrpc and id fields, but the spec types do.
type StripSpecType<T> = Omit<T, "jsonrpc" | "id">;

export type Notification = StripSpecType<Spec.Notification>;
export type CancelledNotification = StripSpecType<Spec.CancelledNotification>;
export type InitializedNotification = StripSpecType<Spec.InitializedNotification>;
export type ProgressNotification = StripSpecType<Spec.ProgressNotification>;
export type ResourceListChangedNotification = StripSpecType<Spec.ResourceListChangedNotification>;
export type ResourceUpdatedNotification = StripSpecType<Spec.ResourceUpdatedNotification>;
export type PromptListChangedNotification = StripSpecType<Spec.PromptListChangedNotification>;
export type ToolListChangedNotification = StripSpecType<Spec.ToolListChangedNotification>;
export type LoggingMessageNotification = StripSpecType<Spec.LoggingMessageNotification>;
export type RootsListChangedNotification = StripSpecType<Spec.RootsListChangedNotification>;

export type Request = StripSpecType<Spec.Request>;
export type InitializeRequest = StripSpecType<Spec.InitializeRequest>;
export type PingRequest = StripSpecType<Spec.PingRequest>;
export type PaginatedRequest = StripSpecType<Spec.PaginatedRequest>;
export type ListResourcesRequest = StripSpecType<Spec.ListResourcesRequest>;
export type ListResourceTemplatesRequest = StripSpecType<Spec.ListResourceTemplatesRequest>;
export type ReadResourceRequest = StripSpecType<Spec.ReadResourceRequest>;
export type SubscribeRequest = StripSpecType<Spec.SubscribeRequest>;
export type UnsubscribeRequest = StripSpecType<Spec.UnsubscribeRequest>;
export type ListPromptsRequest = StripSpecType<Spec.ListPromptsRequest>;
export type GetPromptRequest = StripSpecType<Spec.GetPromptRequest>;
export type ListToolsRequest = StripSpecType<Spec.ListToolsRequest>;
export type CallToolRequest = StripSpecType<Spec.CallToolRequest>;
export type SetLevelRequest = StripSpecType<Spec.SetLevelRequest>;
export type CreateMessageRequest = StripSpecType<Spec.CreateMessageRequest>;
export type ElicitRequest = StripSpecType<Spec.ElicitRequest>;
export type CompleteRequest = StripSpecType<Spec.CompleteRequest>;
export type ListRootsRequest = StripSpecType<Spec.ListRootsRequest>;

export type ClientRequest =
  | PingRequest
  | InitializeRequest
  | CompleteRequest
  | SetLevelRequest
  | GetPromptRequest
  | ListPromptsRequest
  | ListResourcesRequest
  | ListResourceTemplatesRequest
  | ReadResourceRequest
  | SubscribeRequest
  | UnsubscribeRequest
  | CallToolRequest
  | ListToolsRequest;

export type ClientNotification =
  | CancelledNotification
  | ProgressNotification
  | InitializedNotification
  | RootsListChangedNotification;

export type ClientResult =
  | Spec.EmptyResult
  | Spec.CreateMessageResult
  | Spec.ListRootsResult
  | Spec.ElicitResult;

/* Server messages */
export type ServerRequest =
  | PingRequest
  | CreateMessageRequest
  | ListRootsRequest
  | ElicitRequest;

export type ServerNotification =
  | CancelledNotification
  | ProgressNotification
  | LoggingMessageNotification
  | ResourceUpdatedNotification
  | ResourceListChangedNotification
  | ToolListChangedNotification
  | PromptListChangedNotification;

export type ServerResult =
  | Spec.EmptyResult
  | Spec.InitializeResult
  | Spec.CompleteResult
  | Spec.GetPromptResult
  | Spec.ListPromptsResult
  | Spec.ListResourceTemplatesResult
  | Spec.ListResourcesResult
  | Spec.ReadResourceResult
  | Spec.CallToolResult
  | Spec.ListToolsResult;

// These types don't exist in spec.types.ts, so we define them here based on the schemas.
export type Progress = z.infer<typeof ProgressSchema>;
export type RequestMeta = z.infer<typeof RequestMetaSchema>;

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/* JSON-RPC types */
export const JSONRPC_VERSION = "2.0";

/**
 * Error codes defined by the JSON-RPC specification.
 */
export enum ErrorCode {
  // SDK error codes
  ConnectionClosed = -32000,
  RequestTimeout = -32001,

  // Standard JSON-RPC error codes
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
}

export class McpError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(`MCP error ${code}: ${message}`);
    this.name = "McpError";
  }
}

/**
 * Headers that are compatible with both Node.js and the browser.
 */
export type IsomorphicHeaders = Record<string, string | string[] | undefined>;

/**
 * Information about the incoming request.
 */
export interface RequestInfo {
  /**
   * The headers of the request.
   */
  headers: IsomorphicHeaders;
}

/**
 * Extra information about a message.
 */
export interface MessageExtraInfo {
  /**
   * The request information.
   */
  requestInfo?: RequestInfo;

  /**
   * The authentication information.
   */
  authInfo?: AuthInfo;
}
