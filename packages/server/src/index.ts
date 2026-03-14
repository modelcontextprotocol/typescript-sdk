// Server-specific exports
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
export { StdioServerTransport } from './server/stdio.js';
export type {
    EventId,
    EventStore,
    HandleRequestOptions,
    StreamId,
    WebStandardStreamableHTTPServerTransportOptions
} from './server/streamableHttp.js';
export { WebStandardStreamableHTTPServerTransport } from './server/streamableHttp.js';

// experimental exports
export * from './experimental/index.js';

// re-export curated public API from core
export * from '@modelcontextprotocol/core/public';
