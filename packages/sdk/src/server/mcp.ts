export {
    type AnyToolHandler,
    type BaseToolCallback,
    completable,
    type CompletableSchema,
    type CompleteCallback,
    type CompleteResourceTemplateCallback,
    isCompletable,
    type ListResourcesCallback,
    type PromptCallback as LegacyPromptCallback,
    type ToolCallback as LegacyToolCallback,
    type PromptCallback,
    type ReadResourceCallback,
    type ReadResourceTemplateCallback,
    type RegisteredPrompt,
    type RegisteredResource,
    type RegisteredResourceTemplate,
    type RegisteredTool,
    type ResourceMetadata,
    ResourceTemplate,
    type ToolCallback
} from '@modelcontextprotocol/server';
export { McpServer } from '../compatWrappers.js';
