import { AuthInfo } from "./server/auth/types.js";
import { is } from "@babel/types";
export { 
  // type RequestMeta, 
  // type Progress, 
  type ProgressToken, 
  type Cursor, 
  type Request, 
  type Notification, 
  type Result, 
  type RequestId, 
  type JSONRPCRequest, 
  type JSONRPCNotification, 
  type JSONRPCResponse, 
  type JSONRPCError, 
  type JSONRPCMessage, 
  type EmptyResult, 
  type CancelledNotification, 
  type Icon, 
  type Icons, 
  type BaseMetadata, 
  type Implementation, 
  type ClientCapabilities, 
  type InitializeRequest, 
  type ServerCapabilities, 
  type InitializeResult, 
  type InitializedNotification, 
  type PingRequest, 
  type ProgressNotification, 
  type PaginatedRequest, 
  type PaginatedResult, 
  type ResourceContents, 
  type TextResourceContents, 
  type BlobResourceContents, 
  type Resource, 
  type ResourceTemplate, 
  type ListResourcesRequest, 
  type ListResourcesResult, 
  type ListResourceTemplatesRequest, 
  type ListResourceTemplatesResult, 
  type ReadResourceRequest, 
  type ReadResourceResult, 
  type ResourceListChangedNotification, 
  type SubscribeRequest, 
  type UnsubscribeRequest, 
  type ResourceUpdatedNotification, 
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
  type PromptListChangedNotification, 
  type ToolAnnotations, 
  type Tool, 
  type ListToolsRequest, 
  type ListToolsResult, 
  type CallToolResult, 
  type CallToolRequest, 
  type ToolListChangedNotification, 
  type LoggingLevel, 
  type SetLevelRequest, 
  type LoggingMessageNotification, 
  type SamplingMessage, 
  type CreateMessageRequest, 
  type CreateMessageResult, 
  type BooleanSchema, 
  type StringSchema, 
  type NumberSchema, 
  type EnumSchema, 
  type PrimitiveSchemaDefinition, 
  type ElicitRequest, 
  type ElicitResult, 
  type ResourceTemplateReference, 
  type PromptReference, 
  type CompleteRequest, 
  type CompleteResult, 
  type Root, 
  type ListRootsRequest, 
  type ListRootsResult, 
  type RootsListChangedNotification, 
  type ClientRequest, 
  type ClientNotification, 
  type ClientResult, 
  type ServerRequest, 
  type ServerNotification, 
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
