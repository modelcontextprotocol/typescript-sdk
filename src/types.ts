import { AuthInfo } from "./server/auth/types.js";
import { is } from "@babel/types";

import * as Spec from "./spec.types.js";
export { 
  // type RequestMeta, 
  // type Progress, 
  type JSONRPCRequest,
  type JSONRPCResponse, 
  type JSONRPCError,
  type JSONRPCNotification,
  type JSONRPCMessage, 
  
  type ProgressToken, 
  type Cursor,   
  type Result, 
  type RequestId,    
  type EmptyResult,  
  type Icon, 
  type Icons, 
  type BaseMetadata, 
  type Implementation, 
  type ClientCapabilities,  
  type ServerCapabilities, 
  type InitializeResult,     
  type PaginatedResult, 
  type ResourceContents, 
  type TextResourceContents, 
  type BlobResourceContents, 
  type Resource, 
  type ResourceTemplate,  
  type ListResourcesResult,  
  type ListResourceTemplatesResult,  
  type ReadResourceResult,     
  type PromptArgument, 
  type Prompt,  
  type ListPromptsResult,  
  type TextContent, 
  type ImageContent, 
  type AudioContent, 
  type EmbeddedResource, 
  type ResourceLink, 
  type ContentBlock, 
  type PromptMessage, 
  type GetPromptResult,  
  type ToolAnnotations, 
  type Tool,  
  type ListToolsResult, 
  type CallToolResult,   
  type LoggingLevel,   
  type SamplingMessage,  
  type CreateMessageResult, 
  type BooleanSchema, 
  type StringSchema, 
  type NumberSchema, 
  type EnumSchema, 
  type PrimitiveSchemaDefinition,  
  type ElicitResult, 
  type ResourceTemplateReference, 
  type PromptReference,  
  type CompleteResult, 
  type Root,  
  type ListRootsResult,    
  type ClientResult,   
  type ServerResult, 
} from "./spec.types.js";

export {
  isJSONRPCError,
  isJSONRPCResponse,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isInitializeRequest,
  isInitializedNotification,

  // const RequestMetaSchema
  // const BaseRequestParamsSchema
  // const BaseNotificationParamsSchema
  // const Base64Schema
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

import { z } from "zod";

import { ProgressSchema, RequestMetaSchema } from "./schemas.js";

export type Progress = z.infer<typeof ProgressSchema>;
export type RequestMeta = z.infer<typeof RequestMetaSchema>;

export type StripRequest<T> = Omit<T, "jsonrpc" | "id">;
export type StripNotification<T> = Omit<T, "jsonrpc">;

export type Notification = StripNotification<Spec.Notification>;
export type CancelledNotification = StripNotification<Spec.CancelledNotification>;
export type InitializedNotification = StripNotification<Spec.InitializedNotification>;
export type ProgressNotification = StripNotification<Spec.ProgressNotification>;
export type ResourceListChangedNotification = StripNotification<Spec.ResourceListChangedNotification>;
export type ResourceUpdatedNotification = StripNotification<Spec.ResourceUpdatedNotification>;
export type PromptListChangedNotification = StripNotification<Spec.PromptListChangedNotification>;
export type ToolListChangedNotification = StripNotification<Spec.ToolListChangedNotification>;
export type LoggingMessageNotification = StripNotification<Spec.LoggingMessageNotification>;
export type RootsListChangedNotification = StripNotification<Spec.RootsListChangedNotification>;
export type ClientNotification = StripNotification<Spec.ClientNotification>;
export type ServerNotification = StripNotification<Spec.ServerNotification>;

export type Request = StripRequest<Spec.Request>;
export type InitializeRequest = StripRequest<Spec.InitializeRequest>;
export type PingRequest = StripRequest<Spec.PingRequest>;
export type PaginatedRequest = StripRequest<Spec.PaginatedRequest>;
export type ListResourcesRequest = StripRequest<Spec.ListResourcesRequest>;
export type ListResourceTemplatesRequest = StripRequest<Spec.ListResourceTemplatesRequest>;
export type ReadResourceRequest = StripRequest<Spec.ReadResourceRequest>;
export type SubscribeRequest = StripRequest<Spec.SubscribeRequest>;
export type UnsubscribeRequest = StripRequest<Spec.UnsubscribeRequest>;
export type ListPromptsRequest = StripRequest<Spec.ListPromptsRequest>;
export type GetPromptRequest = StripRequest<Spec.GetPromptRequest>;
export type ListToolsRequest = StripRequest<Spec.ListToolsRequest>;
export type CallToolRequest = StripRequest<Spec.CallToolRequest>;
export type SetLevelRequest = StripRequest<Spec.SetLevelRequest>;
export type CreateMessageRequest = StripRequest<Spec.CreateMessageRequest>;
export type ElicitRequest = StripRequest<Spec.ElicitRequest>;
export type CompleteRequest = StripRequest<Spec.CompleteRequest>;
export type ListRootsRequest = StripRequest<Spec.ListRootsRequest>;
export type ClientRequest = StripRequest<Spec.ClientRequest>;
export type ServerRequest = StripRequest<Spec.ServerRequest>;

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
