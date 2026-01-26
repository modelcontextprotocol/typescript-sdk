import type {
    AnyObjectSchema,
    AnySchema,
    GetPromptResult,
    ReadResourceResult,
    ServerNotification,
    ServerRequest,
    ShapeOutput,
    ToolAnnotations,
    ToolExecution,
    Variables,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';

import type { ServerContextInterface } from '../server/context.js';
import type { AnyToolHandler, ResourceMetadata, ResourceTemplate, ToolCallback } from '../server/mcp.js';

/**
 * Base interface for all registered definitions
 */
export interface RegisteredDefinition {
    /**
     * Whether the definition is currently enabled
     */
    enabled: boolean;

    /**
     * Enable the definition
     */
    enable(): void;

    /**
     * Disable the definition
     */
    disable(): void;

    /**
     * Remove the definition from its registry
     */
    remove(): void;

    /**
     * Update the definition
     */
    update(updates: unknown): void;
}

export interface RegisteredToolInterface extends RegisteredDefinition {
    title?: string;
    description?: string;
    inputSchema?: AnySchema;
    outputSchema?: AnySchema;
    annotations?: ToolAnnotations;
    execution?: ToolExecution;
    _meta?: Record<string, unknown>;
    handler: AnyToolHandler<undefined | ZodRawShapeCompat>;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update<InputArgs extends AnySchema, OutputArgs extends AnySchema>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        inputSchema?: InputArgs;
        outputSchema?: OutputArgs;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
        callback?: ToolCallback<InputArgs>;
        enabled?: boolean;
    }): void;
    remove(): void;
}

/**
 * Callback to read a resource at a given URI.
 */
export type ReadResourceCallback = (
    uri: URL,
    ctx: ServerContextInterface<ServerRequest, ServerNotification>
) => ReadResourceResult | Promise<ReadResourceResult>;

export interface RegisteredResourceInterface extends RegisteredDefinition {
    name: string;
    title?: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceCallback;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: {
        name?: string;
        title?: string;
        uri?: string | null;
        metadata?: ResourceMetadata;
        callback?: ReadResourceCallback;
        enabled?: boolean;
    }): void;
    remove(): void;
}

/**
 * Callback to read a resource at a given URI, following a filled-in URI template.
 */
export type ReadResourceTemplateCallback = (
    uri: URL,
    variables: Variables,
    ctx: ServerContextInterface<ServerRequest, ServerNotification>
) => ReadResourceResult | Promise<ReadResourceResult>;

export interface RegisteredResourceTemplateInterface extends RegisteredDefinition {
    resourceTemplate: ResourceTemplate;
    title?: string;
    metadata?: ResourceMetadata;
    readCallback: ReadResourceTemplateCallback;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update(updates: {
        name?: string | null;
        title?: string;
        template?: ResourceTemplate;
        metadata?: ResourceMetadata;
        callback?: ReadResourceTemplateCallback;
        enabled?: boolean;
    }): void;
    remove(): void;
}

export type PromptArgsRawShape = ZodRawShapeCompat;

export type PromptCallback<Args extends undefined | PromptArgsRawShape = undefined> = Args extends PromptArgsRawShape
    ? (
          args: ShapeOutput<Args>,
          ctx: ServerContextInterface<ServerRequest, ServerNotification>
      ) => GetPromptResult | Promise<GetPromptResult>
    : (ctx: ServerContextInterface<ServerRequest, ServerNotification>) => GetPromptResult | Promise<GetPromptResult>;

export interface RegisteredPromptInterface extends RegisteredDefinition {
    title?: string;
    description?: string;
    argsSchema?: AnyObjectSchema;
    callback: PromptCallback<undefined | PromptArgsRawShape>;
    enabled: boolean;
    enable(): void;
    disable(): void;
    update<Args extends PromptArgsRawShape>(updates: {
        name?: string | null;
        title?: string;
        description?: string;
        argsSchema?: Args;
        callback?: PromptCallback<Args>;
        enabled?: boolean;
    }): void;
    remove(): void;
}
