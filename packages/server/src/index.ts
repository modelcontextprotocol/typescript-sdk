// server/completable.ts — public completion API (internals are not re-exported)
export type { CompletableSchema, CompleteCallback } from './server/completable.js';
export { completable, isCompletable } from './server/completable.js';

// server/mcp.ts — high-level server API (internals are not re-exported)
export type {
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

// server/middleware/hostHeaderValidation.ts
export type { HostHeaderValidationResult } from './server/middleware/hostHeaderValidation.js';
export { hostHeaderValidationResponse, localhostAllowedHostnames, validateHostHeader } from './server/middleware/hostHeaderValidation.js';

// server/server.ts
export type { ServerOptions } from './server/server.js';
export { Server } from './server/server.js';

// server/stdio.ts
export { StdioServerTransport } from './server/stdio.js';

// server/streamableHttp.ts — public transport API (StreamId, EventId are not re-exported)
export type { EventStore, HandleRequestOptions, WebStandardStreamableHTTPServerTransportOptions } from './server/streamableHttp.js';
export { WebStandardStreamableHTTPServerTransport } from './server/streamableHttp.js';

// experimental exports
export type { CreateTaskRequestHandler, TaskRequestHandler, ToolTaskHandler } from './experimental/index.js';
export { ExperimentalMcpServerTasks, ExperimentalServerTasks } from './experimental/index.js';

// ============================================================================
// Re-exports from @modelcontextprotocol/core
// Only symbols that are part of the public API are listed here.
// Maintained in a single file to avoid duplication across client and server.
// ============================================================================
export * from '@modelcontextprotocol/core/public';
