/**
 * McpServer Middleware System
 *
 * Provides a flexible middleware system for cross-cutting concerns like
 * logging, authentication, rate limiting, metrics, and caching.
 *
 * Design follows Express/Koa/Hono patterns with the next() pattern for
 * maximum flexibility.
 */

import type { AuthInfo, CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/core';

// ═══════════════════════════════════════════════════════════════════════════
// Context Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base context shared by all middleware
 */
interface BaseMiddlewareContext {
    /** The request ID from JSON-RPC */
    requestId: string;
    /** Authentication info if available */
    authInfo?: AuthInfo;
    /** Abort signal for cancellation */
    signal: AbortSignal;
}

/**
 * Context for tool middleware
 */
export interface ToolContext extends BaseMiddlewareContext {
    type: 'tool';
    /** The name of the tool being called */
    name: string;
    /** The arguments passed to the tool */
    args: unknown;
}

/**
 * Context for resource middleware
 */
export interface ResourceContext extends BaseMiddlewareContext {
    type: 'resource';
    /** The URI of the resource being read */
    uri: string;
}

/**
 * Context for prompt middleware
 */
export interface PromptContext extends BaseMiddlewareContext {
    type: 'prompt';
    /** The name of the prompt being requested */
    name: string;
    /** The arguments passed to the prompt */
    args: unknown;
}

/**
 * Union type for all middleware contexts
 */
export type MiddlewareContext = ToolContext | ResourceContext | PromptContext;

// ═══════════════════════════════════════════════════════════════════════════
// Middleware Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Next function for tool middleware.
 * Can optionally pass modified args to the handler.
 */
export type ToolNextFn = (modifiedArgs?: unknown) => Promise<CallToolResult>;

/**
 * Next function for resource middleware.
 * Can optionally pass a modified URI to the handler.
 */
export type ResourceNextFn = (modifiedUri?: string) => Promise<ReadResourceResult>;

/**
 * Next function for prompt middleware.
 * Can optionally pass modified args to the handler.
 */
export type PromptNextFn = (modifiedArgs?: unknown) => Promise<GetPromptResult>;

/**
 * Next function for universal middleware.
 * Can optionally pass modified input to the handler.
 */
export type UniversalNextFn = (modified?: unknown) => Promise<unknown>;

/**
 * Middleware for tool calls.
 * Can abort, short-circuit, modify args, or pass through.
 */
export type ToolMiddleware = (ctx: ToolContext, next: ToolNextFn) => Promise<CallToolResult>;

/**
 * Middleware for resource reads.
 * Can abort, short-circuit, modify URI, or pass through.
 */
export type ResourceMiddleware = (ctx: ResourceContext, next: ResourceNextFn) => Promise<ReadResourceResult>;

/**
 * Middleware for prompt requests.
 * Can abort, short-circuit, modify args, or pass through.
 */
export type PromptMiddleware = (ctx: PromptContext, next: PromptNextFn) => Promise<GetPromptResult>;

/**
 * Universal middleware that works for all types.
 * Use the `type` property on the context to differentiate.
 */
export type UniversalMiddleware = (ctx: MiddlewareContext, next: UniversalNextFn) => Promise<unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Middleware Chain Builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Composes multiple middleware functions into a single function.
 * Each middleware can:
 * - Abort with error: throw
 * - Short-circuit: return result without calling next()
 * - Modify input: call next(modified)
 * - Pass through: call next()
 *
 * @param middlewares - Array of middleware functions
 * @param handler - The final handler to call
 * @returns A composed function that runs all middleware and the handler
 */
export function composeMiddleware<TCtx, TResult, TInput = unknown>(
    middlewares: Array<(ctx: TCtx, next: (input?: TInput) => Promise<TResult>) => Promise<TResult>>,
    handler: (ctx: TCtx, input?: TInput) => Promise<TResult>
): (ctx: TCtx, initialInput?: TInput) => Promise<TResult> {
    return async (ctx: TCtx, initialInput?: TInput): Promise<TResult> => {
        let index = -1;
        let currentInput: TInput | undefined = initialInput;

        const dispatch = async (i: number, input?: TInput): Promise<TResult> => {
            if (i <= index) {
                throw new Error('next() called multiple times');
            }
            index = i;
            currentInput = input ?? currentInput;

            if (i >= middlewares.length) {
                // All middleware processed, call the final handler
                return handler(ctx, currentInput);
            }

            const middleware = middlewares[i];
            if (!middleware) {
                return handler(ctx, currentInput);
            }
            return middleware(ctx, (modifiedInput?: TInput) => dispatch(i + 1, modifiedInput));
        };

        return dispatch(0, initialInput);
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Middleware Manager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manages middleware registration and execution for McpServer.
 */
export class MiddlewareManager {
    private _universalMiddleware: UniversalMiddleware[] = [];
    private _toolMiddleware: ToolMiddleware[] = [];
    private _resourceMiddleware: ResourceMiddleware[] = [];
    private _promptMiddleware: PromptMiddleware[] = [];

    // Per-item middleware (keyed by name/uri)
    private _perToolMiddleware = new Map<string, ToolMiddleware>();
    private _perResourceMiddleware = new Map<string, ResourceMiddleware>();
    private _perPromptMiddleware = new Map<string, PromptMiddleware>();

    /**
     * Registers universal middleware that runs for all request types.
     */
    useMiddleware(middleware: UniversalMiddleware): this {
        this._universalMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for tool calls.
     */
    useToolMiddleware(middleware: ToolMiddleware): this {
        this._toolMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for resource reads.
     */
    useResourceMiddleware(middleware: ResourceMiddleware): this {
        this._resourceMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for prompt requests.
     */
    usePromptMiddleware(middleware: PromptMiddleware): this {
        this._promptMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware for a specific tool by name.
     */
    useToolMiddlewareFor(name: string, middleware: ToolMiddleware): this {
        this._perToolMiddleware.set(name, middleware);
        return this;
    }

    /**
     * Registers middleware for a specific resource by URI.
     */
    useResourceMiddlewareFor(uri: string, middleware: ResourceMiddleware): this {
        this._perResourceMiddleware.set(uri, middleware);
        return this;
    }

    /**
     * Registers middleware for a specific prompt by name.
     */
    usePromptMiddlewareFor(name: string, middleware: PromptMiddleware): this {
        this._perPromptMiddleware.set(name, middleware);
        return this;
    }

    /**
     * Gets per-tool middleware if registered.
     */
    getToolMiddlewareFor(name: string): ToolMiddleware | undefined {
        return this._perToolMiddleware.get(name);
    }

    /**
     * Gets per-resource middleware if registered.
     */
    getResourceMiddlewareFor(uri: string): ResourceMiddleware | undefined {
        return this._perResourceMiddleware.get(uri);
    }

    /**
     * Gets per-prompt middleware if registered.
     */
    getPromptMiddlewareFor(name: string): PromptMiddleware | undefined {
        return this._perPromptMiddleware.get(name);
    }

    /**
     * Executes tool middleware chain with the given context and handler.
     */
    async executeToolMiddleware(
        ctx: ToolContext,
        handler: (ctx: ToolContext, args?: unknown) => Promise<CallToolResult>,
        perRegistrationMiddleware?: ToolMiddleware
    ): Promise<CallToolResult> {
        // Build middleware chain: universal -> tool-specific -> per-registration
        const chain: ToolMiddleware[] = [];

        // Add universal middleware (cast to tool middleware)
        for (const mw of this._universalMiddleware) {
            chain.push(async (c, next) => {
                return (await mw(c, async modified => {
                    return next(modified as unknown);
                })) as CallToolResult;
            });
        }

        // Add tool-specific middleware
        chain.push(...this._toolMiddleware);

        // Add per-registration middleware if provided
        if (perRegistrationMiddleware) {
            chain.push(perRegistrationMiddleware);
        }

        // Compose and execute
        const composed = composeMiddleware(chain, handler);
        return composed(ctx, ctx.args);
    }

    /**
     * Executes resource middleware chain with the given context and handler.
     */
    async executeResourceMiddleware(
        ctx: ResourceContext,
        handler: (ctx: ResourceContext, uri?: string) => Promise<ReadResourceResult>,
        perRegistrationMiddleware?: ResourceMiddleware
    ): Promise<ReadResourceResult> {
        // Build middleware chain: universal -> resource-specific -> per-registration
        const chain: ResourceMiddleware[] = [];

        // Add universal middleware (cast to resource middleware)
        for (const mw of this._universalMiddleware) {
            chain.push(async (c, next) => {
                return (await mw(c, async modified => {
                    return next(modified as string);
                })) as ReadResourceResult;
            });
        }

        // Add resource-specific middleware
        chain.push(...this._resourceMiddleware);

        // Add per-registration middleware if provided
        if (perRegistrationMiddleware) {
            chain.push(perRegistrationMiddleware);
        }

        // Compose and execute
        const composed = composeMiddleware(chain, handler);
        return composed(ctx, ctx.uri);
    }

    /**
     * Executes prompt middleware chain with the given context and handler.
     */
    async executePromptMiddleware(
        ctx: PromptContext,
        handler: (ctx: PromptContext, args?: unknown) => Promise<GetPromptResult>,
        perRegistrationMiddleware?: PromptMiddleware
    ): Promise<GetPromptResult> {
        // Build middleware chain: universal -> prompt-specific -> per-registration
        const chain: PromptMiddleware[] = [];

        // Add universal middleware (cast to prompt middleware)
        for (const mw of this._universalMiddleware) {
            chain.push(async (c, next) => {
                return (await mw(c, async modified => {
                    return next(modified as unknown);
                })) as GetPromptResult;
            });
        }

        // Add prompt-specific middleware
        chain.push(...this._promptMiddleware);

        // Add per-registration middleware if provided
        if (perRegistrationMiddleware) {
            chain.push(perRegistrationMiddleware);
        }

        // Compose and execute
        const composed = composeMiddleware(chain, handler);
        return composed(ctx, ctx.args);
    }

    /**
     * Checks if any middleware is registered.
     */
    hasMiddleware(): boolean {
        return (
            this._universalMiddleware.length > 0 ||
            this._toolMiddleware.length > 0 ||
            this._resourceMiddleware.length > 0 ||
            this._promptMiddleware.length > 0 ||
            this._perToolMiddleware.size > 0 ||
            this._perResourceMiddleware.size > 0 ||
            this._perPromptMiddleware.size > 0
        );
    }

    /**
     * Clears all registered middleware.
     */
    clear(): void {
        this._universalMiddleware = [];
        this._toolMiddleware = [];
        this._resourceMiddleware = [];
        this._promptMiddleware = [];
        this._perToolMiddleware.clear();
        this._perResourceMiddleware.clear();
        this._perPromptMiddleware.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Built-in Middleware Factories
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for the logging middleware.
 */
export interface LoggingMiddlewareOptions {
    /** Log level: 'debug', 'info', 'warn', 'error' */
    level?: 'debug' | 'info' | 'warn' | 'error';
    /** Custom logger function */
    logger?: (level: string, message: string, data?: unknown) => void;
}

/**
 * Creates a logging middleware that logs all requests.
 *
 * @example
 * ```typescript
 * server.useMiddleware(createLoggingMiddleware({ level: 'debug' }));
 * ```
 */
export function createLoggingMiddleware(options: LoggingMiddlewareOptions = {}): UniversalMiddleware {
    const { level = 'info', logger = console.log } = options;

    return async (ctx, next) => {
        const identifier = ctx.type === 'resource' ? ctx.uri : ctx.name;
        logger(level, `→ ${ctx.type}: ${identifier}`, {
            type: ctx.type,
            requestId: ctx.requestId
        });

        const start = Date.now();

        try {
            const result = await next();
            const duration = Date.now() - start;
            logger(level, `← ${ctx.type}: ${identifier} (${duration}ms)`, {
                type: ctx.type,
                requestId: ctx.requestId,
                duration
            });
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            logger('error', `✗ ${ctx.type}: ${identifier} (${duration}ms)`, {
                type: ctx.type,
                requestId: ctx.requestId,
                duration,
                error
            });
            throw error;
        }
    };
}

/**
 * Options for the rate limit middleware.
 */
export interface RateLimitMiddlewareOptions {
    /** Maximum requests per time window */
    max: number;
    /** Time window in milliseconds */
    windowMs?: number;
    /** Error message when rate limited */
    message?: string;
}