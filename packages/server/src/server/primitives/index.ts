/**
 * Registered primitives for MCP server (tools, prompts, resources).
 * These classes manage the lifecycle of registered items and provide
 * methods to enable, disable, update, and remove them.
 */

// Shared types
export type { OnRemove, OnRename, OnUpdate } from './types.js';

// Tool exports
export {
    type AnyToolHandler,
    type BaseToolCallback,
    RegisteredTool,
    type ToolCallback,
    type ToolConfig,
    type ToolProtocolFields
} from './tool.js';

// Prompt exports
export { type PromptArgsRawShape, type PromptCallback, type PromptConfig, type PromptProtocolFields, RegisteredPrompt } from './prompt.js';

// Resource exports
export {
    type ReadResourceCallback,
    RegisteredResource,
    type ResourceConfig,
    type ResourceMetadata,
    type ResourceProtocolFields
} from './resource.js';

// Resource template exports
export {
    type CompleteResourceTemplateCallback,
    type ListResourcesCallback,
    type ReadResourceTemplateCallback,
    RegisteredResourceTemplate,
    ResourceTemplate,
    type ResourceTemplateConfig,
    type ResourceTemplateProtocolFields
} from './resourceTemplate.js';
