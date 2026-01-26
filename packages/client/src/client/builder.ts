/**
 * Client Builder
 *
 * Provides a fluent API for configuring and creating Client instances.
 * The builder is an additive convenience layer - the existing constructor
 * API remains available for users who prefer it.
 *
 * @example
 * ```typescript
 * const client = Client.builder()
 *   .name('my-client')
 *   .version('1.0.0')
 *   .capabilities({ sampling: {} })
 *   .useMiddleware(loggingMiddleware)
 *   .onSamplingRequest(samplingHandler)
 *   .build();
 * ```
 */

import type {
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageResult,
    CreateMessageResultWithTools,
    CreateTaskResult,
    ElicitRequest,
    ElicitResult,
    jsonSchemaValidator,
    ListChangedHandlers,
    ListRootsRequest,
    ListRootsResult
} from '@modelcontextprotocol/core';

import type { Client } from './client.js';
import type { ClientContextInterface } from './context.js';
import type {
    ClientMiddleware,
    ElicitationMiddleware,
    IncomingMiddleware,
    OutgoingMiddleware,
    ResourceReadMiddleware,
    SamplingMiddleware,
    ToolCallMiddleware
} from './middleware.js';

/**
 * Handler for sampling requests from the server.
 * Receives the full CreateMessageRequest and returns the sampling result.
 * When task creation is requested via params.task, returns CreateTaskResult instead.
 */
export type SamplingRequestHandler = (
    request: CreateMessageRequest,
    ctx: ClientContextInterface
) =>
    | CreateMessageResult
    | CreateMessageResultWithTools
    | CreateTaskResult
    | Promise<CreateMessageResult | CreateMessageResultWithTools | CreateTaskResult>;

/**
 * Handler for elicitation requests from the server.
 * Receives the full ElicitRequest and returns the elicitation result.
 * When task creation is requested via params.task, returns CreateTaskResult instead.
 */
export type ElicitationRequestHandler = (
    request: ElicitRequest,
    ctx: ClientContextInterface
) => ElicitResult | CreateTaskResult | Promise<ElicitResult | CreateTaskResult>;

/**
 * Handler for roots list requests from the server.
 * Receives the full ListRootsRequest and returns the list of roots.
 */
export type RootsListHandler = (request: ListRootsRequest, ctx: ClientContextInterface) => ListRootsResult | Promise<ListRootsResult>;

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
    type: 'sampling' | 'elicitation' | 'rootsList' | 'protocol';
    method: string;
    requestId: string;
}

/**
 * Options for client configuration
 */
export interface ClientBuilderOptions {
    /** Enforce strict capability checking */
    enforceStrictCapabilities?: boolean;
}

/**
 * Fluent builder for Client instances.
 *
 * Provides a declarative, chainable API for configuring clients.
 * All configuration is collected and applied when build() is called.
 */
export class ClientBuilder {
    private _name?: string;
    private _version?: string;
    private _capabilities?: ClientCapabilities;
    private _options: ClientBuilderOptions = {};
    private _jsonSchemaValidator?: jsonSchemaValidator;
    private _listChanged?: ListChangedHandlers;

    // Middleware
    private _universalMiddleware: ClientMiddleware[] = [];
    private _outgoingMiddleware: OutgoingMiddleware[] = [];
    private _incomingMiddleware: IncomingMiddleware[] = [];
    private _toolCallMiddleware: ToolCallMiddleware[] = [];
    private _resourceReadMiddleware: ResourceReadMiddleware[] = [];
    private _samplingMiddleware: SamplingMiddleware[] = [];
    private _elicitationMiddleware: ElicitationMiddleware[] = [];

    // Handlers
    private _samplingHandler?: SamplingRequestHandler;
    private _elicitationHandler?: ElicitationRequestHandler;
    private _rootsListHandler?: RootsListHandler;

    // Error handlers
    private _onError?: OnErrorHandler;
    private _onProtocolError?: OnProtocolErrorHandler;

    /**
     * Sets the client name.
     */
    name(name: string): this {
        this._name = name;
        return this;
    }

    /**
     * Sets the client version.
     */
    version(version: string): this {
        this._version = version;
        return this;
    }

    /**
     * Sets the client capabilities.
     *
     * @example
     * ```typescript
     * .capabilities({
     *   sampling: {},
     *   roots: { listChanged: true }
     * })
     * ```
     */
    capabilities(capabilities: ClientCapabilities): this {
        this._capabilities = { ...this._capabilities, ...capabilities };
        return this;
    }

    /**
     * Sets client options.
     */
    options(options: ClientBuilderOptions): this {
        this._options = { ...this._options, ...options };
        return this;
    }

    /**
     * Sets the JSON Schema validator for tool output validation.
     *
     * @example
     * ```typescript
     * .jsonSchemaValidator(new AjvJsonSchemaValidator())
     * ```
     */
    jsonSchemaValidator(validator: jsonSchemaValidator): this {
        this._jsonSchemaValidator = validator;
        return this;
    }

    /**
     * Configures handlers for list changed notifications (tools, prompts, resources).
     *
     * @example
     * ```typescript
     * .onListChanged({
     *   tools: {
     *     onChanged: (error, tools) => console.log('Tools updated:', tools)
     *   },
     *   prompts: {
     *     onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
     *   }
     * })
     * ```
     */
    onListChanged(handlers: ListChangedHandlers): this {
        this._listChanged = { ...this._listChanged, ...handlers };
        return this;
    }

    /**
     * Adds universal middleware that runs for all requests.
     */
    useMiddleware(middleware: ClientMiddleware): this {
        this._universalMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware for outgoing requests only.
     */
    useOutgoingMiddleware(middleware: OutgoingMiddleware): this {
        this._outgoingMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware for incoming requests only.
     */
    useIncomingMiddleware(middleware: IncomingMiddleware): this {
        this._incomingMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for tool calls.
     */
    useToolCallMiddleware(middleware: ToolCallMiddleware): this {
        this._toolCallMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for resource reads.
     */
    useResourceReadMiddleware(middleware: ResourceReadMiddleware): this {
        this._resourceReadMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for sampling requests.
     */
    useSamplingMiddleware(middleware: SamplingMiddleware): this {
        this._samplingMiddleware.push(middleware);
        return this;
    }

    /**
     * Adds middleware specifically for elicitation requests.
     */
    useElicitationMiddleware(middleware: ElicitationMiddleware): this {
        this._elicitationMiddleware.push(middleware);
        return this;
    }

    /**
     * Sets the handler for sampling requests from the server.
     *
     * @example
     * ```typescript
     * .onSamplingRequest(async (params, ctx) => {
     *   const result = await llm.complete(params.messages);
     *   return { role: 'assistant', content: result };
     * })
     * ```
     */
    onSamplingRequest(handler: SamplingRequestHandler): this {
        this._samplingHandler = handler;
        return this;
    }

    /**
     * Sets the handler for elicitation requests from the server.
     */
    onElicitation(handler: ElicitationRequestHandler): this {
        this._elicitationHandler = handler;
        return this;
    }

    /**
     * Sets the handler for roots list requests from the server.
     */
    onRootsList(handler: RootsListHandler): this {
        this._rootsListHandler = handler;
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
     * Called for protocol-level errors.
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
        capabilities?: ClientCapabilities;
        options: ClientBuilderOptions;
        middlewareCount: number;
        hasHandlers: boolean;
    } {
        return {
            name: this._name,
            version: this._version,
            capabilities: this._capabilities,
            options: this._options,
            middlewareCount:
                this._universalMiddleware.length +
                this._outgoingMiddleware.length +
                this._incomingMiddleware.length +
                this._toolCallMiddleware.length +
                this._resourceReadMiddleware.length +
                this._samplingMiddleware.length +
                this._elicitationMiddleware.length,
            hasHandlers: !!this._samplingHandler || !!this._elicitationHandler || !!this._rootsListHandler
        };
    }

    /**
     * Builds and returns the configured Client instance.
     */
    build(): Client {
        if (!this._name) {
            throw new Error('Client name is required. Use .name() to set it.');
        }
        if (!this._version) {
            throw new Error('Client version is required. Use .version() to set it.');
        }

        const result: ClientBuilderResult = {
            clientInfo: {
                name: this._name,
                version: this._version
            },
            capabilities: this._capabilities,
            options: this._options,
            jsonSchemaValidator: this._jsonSchemaValidator,
            listChanged: this._listChanged,
            middleware: {
                universal: this._universalMiddleware,
                outgoing: this._outgoingMiddleware,
                incoming: this._incomingMiddleware,
                toolCall: this._toolCallMiddleware,
                resourceRead: this._resourceReadMiddleware,
                sampling: this._samplingMiddleware,
                elicitation: this._elicitationMiddleware
            },
            handlers: {
                sampling: this._samplingHandler,
                elicitation: this._elicitationHandler,
                rootsList: this._rootsListHandler
            },
            errorHandlers: {
                onError: this._onError,
                onProtocolError: this._onProtocolError
            }
        };

        // Dynamically import Client to create the instance
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Client: ClientClass } = require('./client.js');
        return ClientClass.fromBuilderResult(result);
    }
}

/**
 * Result of building the client configuration.
 * Used to create the actual Client instance.
 */
export interface ClientBuilderResult {
    clientInfo: {
        name: string;
        version: string;
    };
    capabilities?: ClientCapabilities;
    options: ClientBuilderOptions;
    jsonSchemaValidator?: jsonSchemaValidator;
    listChanged?: ListChangedHandlers;
    middleware: {
        universal: ClientMiddleware[];
        outgoing: OutgoingMiddleware[];
        incoming: IncomingMiddleware[];
        toolCall: ToolCallMiddleware[];
        resourceRead: ResourceReadMiddleware[];
        sampling: SamplingMiddleware[];
        elicitation: ElicitationMiddleware[];
    };
    handlers: {
        sampling?: SamplingRequestHandler;
        elicitation?: ElicitationRequestHandler;
        rootsList?: RootsListHandler;
    };
    errorHandlers: {
        onError?: OnErrorHandler;
        onProtocolError?: OnProtocolErrorHandler;
    };
}

/**
 * Creates a new ClientBuilder instance.
 *
 * @example
 * ```typescript
 * const client = createClientBuilder()
 *   .name('my-client')
 *   .version('1.0.0')
 *   .capabilities({ sampling: {} })
 *   .build();
 * ```
 */
export function createClientBuilder(): ClientBuilder {
    return new ClientBuilder();
}
