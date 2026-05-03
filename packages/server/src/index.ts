// Public API for @modelcontextprotocol/server.
//
// This file defines the complete public surface. It consists of:
//   - Package-specific exports: listed explicitly below (named imports)
//   - Protocol-level types: re-exported from @modelcontextprotocol/core/public
//
// Any new export added here becomes public API. Use named exports, not wildcards.

export type { CompletableSchema, CompleteCallback } from './server/completable.js';
export { completable, isCompletable } from './server/completable.js';
export type {
    AnyToolHandler,
    BaseToolCallback,
    CompleteResourceTemplateCallback,
    ListResourcesCallback,
    PromptCallback,
    ReadResourceCallback,
    ReadResourceTemplateCallback,
    RegisteredPrompt,
    RegisteredResource,
    RegisteredResourceTemplate,
    RegisteredTool,
    ResourceMetadata,
    ToolCallback
} from './server/mcp.js';
export { McpServer, ResourceTemplate } from './server/mcp.js';
export type { HostHeaderValidationResult } from './server/middleware/hostHeaderValidation.js';
export { hostHeaderValidationResponse, localhostAllowedHostnames, validateHostHeader } from './server/middleware/hostHeaderValidation.js';
export type { ServerOptions } from './server/server.js';
export { Server } from './server/server.js';
// StdioServerTransport is exported from the './stdio' subpath — server stdio has only type-level Node
// imports (erased at compile time), but matching the client's `./stdio` subpath gives consumers a
// consistent shape across packages.
export type {
    EventId,
    EventStore,
    HandleRequestOptions,
    StreamId,
    WebStandardStreamableHTTPServerTransportOptions
} from './server/streamableHttp.js';
export { WebStandardStreamableHTTPServerTransport } from './server/streamableHttp.js';

// experimental exports
export type { CreateTaskRequestHandler, TaskRequestHandler, ToolTaskHandler } from './experimental/tasks/interfaces.js';
export { ExperimentalMcpServerTasks } from './experimental/tasks/mcpServer.js';
export { ExperimentalServerTasks } from './experimental/tasks/server.js';

// runtime-aware wrapper (shadows core/public's fromJsonSchema with optional validator)
export { fromJsonSchema } from './fromJsonSchema.js';

// re-export curated public API from core
export * from '@modelcontextprotocol/core/public';
