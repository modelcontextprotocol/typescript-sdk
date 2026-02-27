/**
 * Main entry point for the Model Context Protocol TypeScript SDK
 * 
 * This file resolves issue #971 by providing a main index that exports
 * all commonly used types, classes, and constants from the MCP SDK.
 * 
 * It enables imports like:
 * import { McpError, ErrorCode, Client, Server } from "@modelcontextprotocol/sdk"
 */

// Export core types and error handling
export {
  McpError,
  ErrorCode,
  
  // Protocol constants
  LATEST_PROTOCOL_VERSION,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSONRPC_VERSION,
  
  // Core type schemas and validators
  RequestIdSchema,
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResponseSchema,
  JSONRPCErrorSchema,
  JSONRPCMessageSchema,
  EmptyResultSchema,
  
  // Utility functions
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResponse,
  isJSONRPCError,
  isInitializeRequest,
  isInitializedNotification,
  
  // Core MCP types
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
  
  // Protocol types
  type InitializeRequest,
  type InitializeResult,
  type InitializedNotification,
  type PingRequest,
  type ProgressNotification,
  type CancelledNotification,
  
  // Capabilities
  type ClientCapabilities,
  type ServerCapabilities,
  type Implementation,
  
  // Resources
  type Resource,
  type ResourceContents,
  type TextResourceContents,
  type BlobResourceContents,
  type ResourceTemplate,
  type ListResourcesRequest,
  type ListResourcesResult,
  type ReadResourceRequest,
  type ReadResourceResult,
  type SubscribeRequest,
  type UnsubscribeRequest,
  type ResourceUpdatedNotification,
  type ResourceListChangedNotification,
  
  // Tools
  type Tool,
  type ToolAnnotations,
  type CallToolRequest,
  type CallToolResult,
  type CompatibilityCallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
  type ToolListChangedNotification,
  
  // Prompts
  type Prompt,
  type PromptArgument,
  type PromptMessage,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsRequest,
  type ListPromptsResult,
  type PromptListChangedNotification,
  
  // Content types
  type TextContent,
  type ImageContent,
  type AudioContent,
  type ContentBlock,
  type EmbeddedResource,
  type ResourceLink,
  
  // Logging
  type LoggingLevel,
  type SetLevelRequest,
  type LoggingMessageNotification,
  
  // Sampling
  type SamplingMessage,
  type CreateMessageRequest,
  type CreateMessageResult,
  
  // Elicitation
  type ElicitRequest,
  type ElicitResult,
  
  // Autocomplete
  type CompleteRequest,
  type CompleteResult,
  type ResourceTemplateReference,
  type PromptReference,
  
  // Roots
  type Root,
  type ListRootsRequest,
  type ListRootsResult,
  type RootsListChangedNotification,
  
  // Message type unions
  type ClientRequest,
  type ClientNotification,
  type ClientResult,
  type ServerRequest,
  type ServerNotification,
  type ServerResult,
  
  // Metadata and utilities
  type Icon,
  type BaseMetadata,
  type RequestInfo,
  type MessageExtraInfo,
  type IsomorphicHeaders,
} from "./types.js";

// Export client functionality
export { Client } from "./client/index.js";
export type { ClientOptions } from "./client/index.js";

// Export server functionality
export { Server } from "./server/index.js";
export type { ServerOptions } from "./server/index.js";

// Export transport and protocol utilities
export type { Transport } from "./shared/transport.js";

export { Protocol, mergeCapabilities } from "./shared/protocol.js";
export type { ProtocolOptions, RequestOptions } from "./shared/protocol.js";

// Export transport implementations
export * from "./client/stdio.js";
export * from "./client/sse.js";
export * from "./client/streamableHttp.js";
export * from "./client/websocket.js";

export * from "./server/stdio.js";
export * from "./server/sse.js";
export * from "./server/streamableHttp.js";

// Export in-memory transport for testing
export * from "./inMemory.js";