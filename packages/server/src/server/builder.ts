/**
 * McpServer Builder
 *
 * Provides a fluent API for configuring and creating McpServer instances.
 * The builder is an additive convenience layer - the existing constructor
 * API remains available for users who prefer it.
 *
 * @example
 * ```typescript
 * const server = McpServer.builder()
 *   .name('my-server')
 *   .version('1.0.0')
 *   .useMiddleware(loggingMiddleware)
 *   .tool('greet', { inputSchema: { name: z.string() } }, handler)
 *   .build();
 * ```
 */

import type { ToolAnnotations, ToolExecution, ZodRawShapeCompat } from '@modelcontextprotocol/core';
import { objectFromShape } from '@modelcontextprotocol/core';

import type { PromptCallback, ReadResourceCallback } from '../types/types.js';
import type { McpServer, ResourceMetadata, ToolCallback } from './mcp.js';
import type { PromptMiddleware, ResourceMiddleware, ToolMiddleware, UniversalMiddleware } from './middleware.js';
import { PromptRegistry } from './registries/promptRegistry.js';
import { ResourceRegistry } from './registries/resourceRegistry.js';
import { ToolRegistry } from './registries/toolRegistry.js';
import type { ServerOptions as BaseServerOptions } from './server.js';

// ZodRawShape for backward compatibility
type ZodRawShape = ZodRawShapeCompat;

/**
 * Extended server options including builder-specific options
 */
export interface McpServerBuilderOptions extends BaseServerOptions {
    /** Server name */
    name?: string;
    /** Server version */
    version?: string;
}

/**
 * Error handler type for application errors
 */
export type OnErrorHandler = (error: Error, ctx: ErrorContext) => OnErrorReturn | void | Promise<OnErrorReturn | void>;

/**
 * Error handler type for protocol errors
 */
export type OnProtocolErrorHandler = (
    error: Error,
    ctx: ErrorContext
) => OnProtocolErrorReturn | void | Promise<OnProtocolErrorReturn | void>;

/**
 * Return type for onError handler
 */
export type OnErrorReturn = string | { code?: number; message?: string; data?: unknown } | Error;

/**
 * Return type for onProtocolError handler (code cannot be changed)
 */
export type OnProtocolErrorReturn = string | { message?: string; data?: unknown };

/**
 * Context provided to error handlers
 */
export interface ErrorContext {
    type: 'tool' | 'resource' | 'prompt' | 'protocol';
    name?: string;
    method: string;
    requestId: string;
}

/**
 * Fluent builder for McpServer instances.
 *
 * Provides a declarative, chainable API for configuring servers.
 * All configuration is collected and applied when build() is called.
 */
export class McpServerBuilder {
    private _name?: string;
    private _version?: string;
    private _options: McpServerBuilderOptions = {};

    // Global middleware
    private _universalMiddleware: UniversalMiddleware[] = [];
    private _toolMiddleware: ToolMiddleware[] = [];
    private _resourceMiddleware: ResourceMiddleware[] = [];
    private _promptMiddleware: PromptMiddleware[] = [];

    // Registries (created without callbacks - McpServer will bind them later)
    private _toolRegistry = new ToolRegistry();
    private _resourceRegistry = new ResourceRegistry();
    private _promptRegistry = new PromptRegistry();

    // Per-item middleware (keyed by name/uri)
    private _perToolMiddleware = new Map<string, ToolMiddleware>();
    private _perResourceMiddleware = new Map<string, ResourceMiddleware>();
    private _perPromptMiddleware = new Map<string, PromptMiddleware>();

    // Error handlers
    private _onError?: OnErrorHandler;
    private _onProtocolError?: OnProtocolErrorHandler;

    /**
     * Sets the server name.
     */
    name(name: string): this {
        this._name = name;
        return this;
    }

    /**
     * Sets the server version.
     */
    version(version: string): this {
        this._version = version;
        return this;
    }

    /**
     * Sets server options.
     */
    options(options: McpServerBuilderOptions): this {
        this._options = { ...this._options, ...options };
        return this;
    }

    /**
     * Adds universal middleware that runs for all request types.
     */
    useMiddleware(middleware: UniversalMiddleware): this {
        this._universalMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for tool calls.
     */
    useToolMiddleware(middleware: ToolMiddleware): this {
        this._toolMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for resource reads.
     */
    useResourceMiddleware(middleware: ResourceMiddleware): this {
        this._resourceMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for prompt requests.
     */
    usePromptMiddleware(middleware: PromptMiddleware): this {
        this._promptMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers a tool with the server.
     *
     * @example
     * ```typescript
     * .tool('greet', {
     *   description: 'Greet a user',
     *   inputSchema: { name: z.string() }
     * }, async ({ name }) => {
     *   return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
     * })
     * ```
     */
    tool<InputArgs extends ZodRawShape | undefined = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            inputSchema?: InputArgs;
            outputSchema?: ZodRawShape;
            middleware?: ToolMiddleware;
            annotations?: ToolAnnotations;
            execution?: ToolExecution;
            _meta?: Record<string, unknown>;
        },
        handler: ToolCallback<InputArgs>
    ): this {
        this._toolRegistry.register({
            name,
            title: config.title,
            description: config.description,
            inputSchema: config.inputSchema ? objectFromShape(config.inputSchema) : undefined,
            outputSchema: config.outputSchema ? objectFromShape(config.outputSchema) : undefined,
            annotations: config.annotations,
            execution: config.execution,
            _meta: config._meta,
            handler: handler as ToolCallback<ZodRawShape | undefined>
        });

        // Store per-tool middleware if provided
        if (config.middleware) {
            this._perToolMiddleware.set(name, config.middleware);
        }

        return this;
    }

    /**
     * Registers a resource with the server.
     *
     * @example
     * ```typescript
     * .resource('config', 'file:///config', {
     *   description: 'Configuration file'
     * }, async (uri) => {
     *   return { contents: [{ uri, mimeType: 'application/json', text: '{}' }] };
     * })
     * ```
     */
    resource(
        name: string,
        uri: string,
        config: {
            title?: string;
            description?: string;
            mimeType?: string;
            metadata?: ResourceMetadata;
            middleware?: ResourceMiddleware;
        },
        readCallback: ReadResourceCallback
    ): this {
        this._resourceRegistry.register({
            name,
            uri,
            title: config.title,
            description: config.description,
            mimeType: config.mimeType,
            metadata: config.metadata,
            readCallback
        });

        // Store per-resource middleware if provided
        if (config.middleware) {
            this._perResourceMiddleware.set(uri, config.middleware);
        }

        return this;
    }

    /**
     * Registers a prompt with the server.
     *
     * @example
     * ```typescript
     * .prompt('summarize', {
     *   description: 'Summarize text',
     *   argsSchema: { text: z.string() }
     * }, async ({ text }) => {
     *   return { messages: [{ role: 'user', content: { type: 'text', text } }] };
     * })
     * ```
     */
    prompt<Args extends ZodRawShape | undefined = undefined>(
        name: string,
        config: {
            title?: string;
            description?: string;
            argsSchema?: Args;
            middleware?: PromptMiddleware;
        },
        callback: PromptCallback<Args>
    ): this {
        this._promptRegistry.register({
            name,
            title: config.title,
            description: config.description,
            argsSchema: config.argsSchema,
            callback: callback as PromptCallback<ZodRawShape | undefined>
        });

        // Store per-prompt middleware if provided
        if (config.middleware) {
            this._perPromptMiddleware.set(name, config.middleware);
        }

        return this;
    }

    /**
     * Sets the application error handler.
     * Called when a handler throws an error.
     */
    onError(handler: OnErrorHandler): this {
        this._onError = handler;
        return this;
    }

    /**
     * Sets the protocol error handler.
     * Called for protocol-level errors (parse, method not found, etc.)
     */
    onProtocolError(handler: OnProtocolErrorHandler): this {
        this._onProtocolError = handler;
        return this;
    }

    /**
     * Gets the collected configuration (for debugging/testing).
     */
    getConfig(): {
        name?: string;
        version?: string;
        options: McpServerBuilderOptions;
        toolCount: number;
        resourceCount: number;
        promptCount: number;
        middlewareCount: number;
    } {
        return {
            name: this._name,
            version: this._version,
            options: this._options,
            toolCount: this._toolRegistry.size,
            resourceCount: this._resourceRegistry.size,
            promptCount: this._promptRegistry.size,
            middlewareCount:
                this._universalMiddleware.length +
                this._toolMiddleware.length +
                this._resourceMiddleware.length +
                this._promptMiddleware.length
        };
    }

    /**
     * Builds and returns the configured McpServer instance.
     */
    build(): McpServer {
        if (!this._name) {
            throw new Error('Server name is required. Use .name() to set it.');
        }
        if (!this._version) {
            throw new Error('Server version is required. Use .version() to set it.');
        }

        const result: BuilderResult = {
            serverInfo: {
                name: this._name,
                version: this._version
            },
            options: this._options,
            middleware: {
                universal: this._universalMiddleware,
                tool: this._toolMiddleware,
                resource: this._resourceMiddleware,
                prompt: this._promptMiddleware
            },
            registries: {
                tools: this._toolRegistry,
                resources: this._resourceRegistry,
                prompts: this._promptRegistry
            },
            perItemMiddleware: {
                tools: this._perToolMiddleware,
                resources: this._perResourceMiddleware,
                prompts: this._perPromptMiddleware
            },
            errorHandlers: {
                onError: this._onError,
                onProtocolError: this._onProtocolError
            }
        };

        // Dynamically import McpServer to create the instance
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { McpServer: McpServerClass } = require('./mcp.js');
        return McpServerClass.fromBuilderResult(result);
    }
}

/**
 * Result of building the server configuration.
 * Used to create the actual McpServer instance.
 */
export interface BuilderResult {
    serverInfo: {
        name: string;
        version: string;
    };
    options: McpServerBuilderOptions;
    middleware: {
        universal: UniversalMiddleware[];
        tool: ToolMiddleware[];
        resource: ResourceMiddleware[];
        prompt: PromptMiddleware[];
    };
    registries: {
        tools: ToolRegistry;
        resources: ResourceRegistry;
        prompts: PromptRegistry;
    };
    perItemMiddleware: {
        tools: Map<string, ToolMiddleware>;
        resources: Map<string, ResourceMiddleware>;
        prompts: Map<string, PromptMiddleware>;
    };
    errorHandlers: {
        onError?: OnErrorHandler;
        onProtocolError?: OnProtocolErrorHandler;
    };
}

/**
 * Creates a new McpServerBuilder instance.
 *
 * @example
 * ```typescript
 * const server = createServerBuilder()
 *   .name('my-server')
 *   .version('1.0.0')
 *   .tool('greet', { inputSchema: { name: z.string() } }, handler)
 *   .build();
 * ```
 */
export function createServerBuilder(): McpServerBuilder {
    return new McpServerBuilder();
}
