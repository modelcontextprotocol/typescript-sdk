/**
 * Client Middleware System
 *
 * This module provides two distinct middleware systems:
 *
 * 1. Fetch Middleware - For HTTP/fetch level operations (OAuth, logging, etc.)
 * 2. MCP Client Middleware - For MCP protocol level operations (tool calls, sampling, etc.)
 */

import type {
    AuthInfo,
    CallToolResult,
    CreateMessageResult,
    ElicitResult,
    FetchLike,
    ReadResourceResult
} from '@modelcontextprotocol/core';

import type { OAuthClientProvider } from './auth.js';
import { auth, extractWWWAuthenticateParams, UnauthorizedError } from './auth.js';

// ═══════════════════════════════════════════════════════════════════════════
// Fetch Middleware (HTTP Level)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Middleware function that wraps and enhances fetch functionality.
 * Takes a fetch handler and returns an enhanced fetch handler.
 */
export type Middleware = (next: FetchLike) => FetchLike;

/**
 * Creates a fetch wrapper that handles OAuth authentication automatically.
 *
 * This wrapper will:
 * - Add Authorization headers with access tokens
 * - Handle 401 responses by attempting re-authentication
 * - Retry the original request after successful auth
 * - Handle OAuth errors appropriately (InvalidClientError, etc.)
 *
 * The baseUrl parameter is optional and defaults to using the domain from the request URL.
 * However, you should explicitly provide baseUrl when:
 * - Making requests to multiple subdomains (e.g., api.example.com, cdn.example.com)
 * - Using API paths that differ from OAuth discovery paths (e.g., requesting /api/v1/data but OAuth is at /)
 * - The OAuth server is on a different domain than your API requests
 * - You want to ensure consistent OAuth behavior regardless of request URLs
 *
 * For MCP transports, set baseUrl to the same URL you pass to the transport constructor.
 *
 * Note: This wrapper is designed for general-purpose fetch operations.
 * MCP transports (SSE and StreamableHTTP) already have built-in OAuth handling
 * and should not need this wrapper.
 *
 * @param provider - OAuth client provider for authentication
 * @param baseUrl - Base URL for OAuth server discovery (defaults to request URL domain)
 * @returns A fetch middleware function
 */
export const withOAuth =
    (provider: OAuthClientProvider, baseUrl?: string | URL): Middleware =>
    next => {
        return async (input, init) => {
            const makeRequest = async (): Promise<Response> => {
                const headers = new Headers(init?.headers);

                // Add authorization header if tokens are available
                const tokens = await provider.tokens();
                if (tokens) {
                    headers.set('Authorization', `Bearer ${tokens.access_token}`);
                }

                return await next(input, { ...init, headers });
            };

            let response = await makeRequest();

            // Handle 401 responses by attempting re-authentication
            if (response.status === 401) {
                try {
                    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);

                    // Use provided baseUrl or extract from request URL
                    const serverUrl = baseUrl || (typeof input === 'string' ? new URL(input).origin : input.origin);

                    const result = await auth(provider, {
                        serverUrl,
                        resourceMetadataUrl,
                        scope,
                        fetchFn: next
                    });

                    if (result === 'REDIRECT') {
                        throw new UnauthorizedError('Authentication requires user authorization - redirect initiated');
                    }

                    if (result !== 'AUTHORIZED') {
                        throw new UnauthorizedError(`Authentication failed with result: ${result}`);
                    }

                    // Retry the request with fresh tokens
                    response = await makeRequest();
                } catch (error) {
                    if (error instanceof UnauthorizedError) {
                        throw error;
                    }
                    throw new UnauthorizedError(`Failed to re-authenticate: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            // If we still have a 401 after re-auth attempt, throw an error
            if (response.status === 401) {
                const url = typeof input === 'string' ? input : input.toString();
                throw new UnauthorizedError(`Authentication failed for ${url}`);
            }

            return response;
        };
    };

/**
 * Logger function type for HTTP requests
 */
export type RequestLogger = (input: {
    method: string;
    url: string | URL;
    status: number;
    statusText: string;
    duration: number;
    requestHeaders?: Headers;
    responseHeaders?: Headers;
    error?: Error;
}) => void;

/**
 * Configuration options for the logging middleware
 */
export type LoggingOptions = {
    /**
     * Custom logger function, defaults to console logging
     */
    logger?: RequestLogger;

    /**
     * Whether to include request headers in logs
     * @default false
     */
    includeRequestHeaders?: boolean;

    /**
     * Whether to include response headers in logs
     * @default false
     */
    includeResponseHeaders?: boolean;

    /**
     * Status level filter - only log requests with status >= this value
     * Set to 0 to log all requests, 400 to log only errors
     * @default 0
     */
    statusLevel?: number;
};

/**
 * Creates a fetch middleware that logs HTTP requests and responses.
 *
 * When called without arguments `withLogging()`, it uses the default logger that:
 * - Logs successful requests (2xx) to `console.log`
 * - Logs error responses (4xx/5xx) and network errors to `console.error`
 * - Logs all requests regardless of status (statusLevel: 0)
 * - Does not include request or response headers in logs
 * - Measures and displays request duration in milliseconds
 *
 * Important: the default logger uses both `console.log` and `console.error` so it should not be used with
 * `stdio` transports and applications.
 *
 * @param options - Logging configuration options
 * @returns A fetch middleware function
 */
export const withLogging = (options: LoggingOptions = {}): Middleware => {
    const { logger, includeRequestHeaders = false, includeResponseHeaders = false, statusLevel = 0 } = options;

    const defaultLogger: RequestLogger = input => {
        const { method, url, status, statusText, duration, requestHeaders, responseHeaders, error } = input;

        let message = error
            ? `HTTP ${method} ${url} failed: ${error.message} (${duration}ms)`
            : `HTTP ${method} ${url} ${status} ${statusText} (${duration}ms)`;

        // Add headers to message if requested
        if (includeRequestHeaders && requestHeaders) {
            const reqHeaders = [...requestHeaders.entries()].map(([key, value]) => `${key}: ${value}`).join(', ');
            message += `\n  Request Headers: {${reqHeaders}}`;
        }

        if (includeResponseHeaders && responseHeaders) {
            const resHeaders = [...responseHeaders.entries()].map(([key, value]) => `${key}: ${value}`).join(', ');
            message += `\n  Response Headers: {${resHeaders}}`;
        }

        if (error || status >= 400) {
            // eslint-disable-next-line no-console
            console.error(message);
        } else {
            // eslint-disable-next-line no-console
            console.log(message);
        }
    };

    const logFn = logger || defaultLogger;

    return next => async (input, init) => {
        const startTime = performance.now();
        const method = init?.method || 'GET';
        const url = typeof input === 'string' ? input : input.toString();
        const requestHeaders = includeRequestHeaders ? new Headers(init?.headers) : undefined;

        try {
            const response = await next(input, init);
            const duration = performance.now() - startTime;

            // Only log if status meets the log level threshold
            if (response.status >= statusLevel) {
                logFn({
                    method,
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    duration,
                    requestHeaders,
                    responseHeaders: includeResponseHeaders ? response.headers : undefined
                });
            }

            return response;
        } catch (error) {
            const duration = performance.now() - startTime;

            // Always log errors regardless of log level
            logFn({
                method,
                url,
                status: 0,
                statusText: 'Network Error',
                duration,
                requestHeaders,
                error: error as Error
            });

            throw error;
        }
    };
};

/**
 * Composes multiple fetch middleware functions into a single middleware pipeline.
 * Middleware are applied in the order they appear, creating a chain of handlers.
 *
 * @example
 * ```typescript
 * // Create a middleware pipeline that handles both OAuth and logging
 * const enhancedFetch = applyMiddlewares(
 *   withOAuth(oauthProvider, 'https://api.example.com'),
 *   withLogging({ statusLevel: 400 })
 * )(fetch);
 *
 * // Use the enhanced fetch - it will handle auth and log errors
 * const response = await enhancedFetch('https://api.example.com/data');
 * ```
 *
 * @param middleware - Array of fetch middleware to compose into a pipeline
 * @returns A single composed middleware function
 */
export const applyMiddlewares = (...middleware: Middleware[]): Middleware => {
    return next => {
        let handler = next;
        for (const mw of middleware) {
            handler = mw(handler);
        }
        return handler;
    };
};

/**
 * Helper function to create custom fetch middleware with cleaner syntax.
 * Provides the next handler and request details as separate parameters for easier access.
 *
 * @example
 * ```typescript
 * // Create custom authentication middleware
 * const customAuthMiddleware = createMiddleware(async (next, input, init) => {
 *   const headers = new Headers(init?.headers);
 *   headers.set('X-Custom-Auth', 'my-token');
 *
 *   const response = await next(input, { ...init, headers });
 *
 *   if (response.status === 401) {
 *     console.log('Authentication failed');
 *   }
 *
 *   return response;
 * });
 *
 * // Create conditional middleware
 * const conditionalMiddleware = createMiddleware(async (next, input, init) => {
 *   const url = typeof input === 'string' ? input : input.toString();
 *
 *   // Only add headers for API routes
 *   if (url.includes('/api/')) {
 *     const headers = new Headers(init?.headers);
 *     headers.set('X-API-Version', 'v2');
 *     return next(input, { ...init, headers });
 *   }
 *
 *   // Pass through for non-API routes
 *   return next(input, init);
 * });
 *
 * // Create caching middleware
 * const cacheMiddleware = createMiddleware(async (next, input, init) => {
 *   const cacheKey = typeof input === 'string' ? input : input.toString();
 *
 *   // Check cache first
 *   const cached = await getFromCache(cacheKey);
 *   if (cached) {
 *     return new Response(cached, { status: 200 });
 *   }
 *
 *   // Make request and cache result
 *   const response = await next(input, init);
 *   if (response.ok) {
 *     await saveToCache(cacheKey, await response.clone().text());
 *   }
 *
 *   return response;
 * });
 * ```
 *
 * @param handler - Function that receives the next handler and request parameters
 * @returns A fetch middleware function
 */
export const createMiddleware = (handler: (next: FetchLike, input: string | URL, init?: RequestInit) => Promise<Response>): Middleware => {
    return next => (input, init) => handler(next, input as string | URL, init);
};

// ═══════════════════════════════════════════════════════════════════════════
// MCP Client Middleware (Protocol Level)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base context shared by all MCP client middleware
 */
interface BaseClientContext {
    /** The request ID */
    requestId: string;
    /** Abort signal for cancellation */
    signal: AbortSignal;
}

/**
 * Context for outgoing requests (client → server)
 */
export interface OutgoingContext extends BaseClientContext {
    direction: 'outgoing';
    /** The type of outgoing request */
    type:
        | 'callTool'
        | 'readResource'
        | 'getPrompt'
        | 'listTools'
        | 'listResources'
        | 'listPrompts'
        | 'ping'
        | 'complete'
        | 'initialize'
        | 'other';
    /** The JSON-RPC method name */
    method: string;
    /** The request parameters */
    params: unknown;
}

/**
 * Context for incoming requests (server → client)
 */
export interface IncomingContext extends BaseClientContext {
    direction: 'incoming';
    /** The type of incoming request */
    type: 'sampling' | 'elicitation' | 'rootsList' | 'other';
    /** The JSON-RPC method name */
    method: string;
    /** The request parameters */
    params: unknown;
    /** Authentication info if available */
    authInfo?: AuthInfo;
}

/**
 * Union type for all client contexts
 */
export type ClientContext = OutgoingContext | IncomingContext;

// ═══════════════════════════════════════════════════════════════════════════
// Type-Specific Contexts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Context for tool call requests
 */
export interface ToolCallContext extends OutgoingContext {
    type: 'callTool';
    params: {
        name: string;
        arguments?: unknown;
    };
}

/**
 * Context for resource read requests
 */
export interface ResourceReadContext extends OutgoingContext {
    type: 'readResource';
    params: {
        uri: string;
    };
}

/**
 * Context for sampling requests (server → client)
 */
export interface SamplingContext extends IncomingContext {
    type: 'sampling';
    params: {
        messages: unknown[];
        maxTokens?: number;
        [key: string]: unknown;
    };
}

/**
 * Context for elicitation requests (server → client)
 */
export interface ElicitationContext extends IncomingContext {
    type: 'elicitation';
    params: {
        message?: string;
        [key: string]: unknown;
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP Middleware Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Next function for MCP client middleware
 */
export type ClientNextFn<T = unknown> = (modifiedParams?: unknown) => Promise<T>;

/**
 * Universal middleware for all MCP client requests
 */
export type ClientMiddleware = (ctx: ClientContext, next: ClientNextFn<unknown>) => Promise<unknown>;

/**
 * Middleware for outgoing requests only
 */
export type OutgoingMiddleware = (ctx: OutgoingContext, next: ClientNextFn<unknown>) => Promise<unknown>;

/**
 * Middleware for incoming requests only
 */
export type IncomingMiddleware = (ctx: IncomingContext, next: ClientNextFn<unknown>) => Promise<unknown>;

/**
 * Middleware specifically for tool calls
 */
export type ToolCallMiddleware = (ctx: ToolCallContext, next: ClientNextFn<CallToolResult>) => Promise<CallToolResult>;

/**
 * Middleware specifically for resource reads
 */
export type ResourceReadMiddleware = (ctx: ResourceReadContext, next: ClientNextFn<ReadResourceResult>) => Promise<ReadResourceResult>;

/**
 * Middleware specifically for sampling requests
 */
export type SamplingMiddleware = (ctx: SamplingContext, next: ClientNextFn<CreateMessageResult>) => Promise<CreateMessageResult>;

/**
 * Middleware specifically for elicitation requests
 */
export type ElicitationMiddleware = (ctx: ElicitationContext, next: ClientNextFn<ElicitResult>) => Promise<ElicitResult>;

// ═══════════════════════════════════════════════════════════════════════════
// MCP Middleware Manager
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Manages MCP middleware registration and execution for Client.
 */
export class ClientMiddlewareManager {
    private _universalMiddleware: ClientMiddleware[] = [];
    private _outgoingMiddleware: OutgoingMiddleware[] = [];
    private _incomingMiddleware: IncomingMiddleware[] = [];
    private _toolCallMiddleware: ToolCallMiddleware[] = [];
    private _resourceReadMiddleware: ResourceReadMiddleware[] = [];
    private _samplingMiddleware: SamplingMiddleware[] = [];
    private _elicitationMiddleware: ElicitationMiddleware[] = [];

    /**
     * Registers universal middleware that runs for all requests.
     */
    useMiddleware(middleware: ClientMiddleware): this {
        this._universalMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware for outgoing requests only.
     */
    useOutgoingMiddleware(middleware: OutgoingMiddleware): this {
        this._outgoingMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware for incoming requests only.
     */
    useIncomingMiddleware(middleware: IncomingMiddleware): this {
        this._incomingMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for tool calls.
     */
    useToolCallMiddleware(middleware: ToolCallMiddleware): this {
        this._toolCallMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for resource reads.
     */
    useResourceReadMiddleware(middleware: ResourceReadMiddleware): this {
        this._resourceReadMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for sampling requests.
     */
    useSamplingMiddleware(middleware: SamplingMiddleware): this {
        this._samplingMiddleware.push(middleware);
        return this;
    }

    /**
     * Registers middleware specifically for elicitation requests.
     */
    useElicitationMiddleware(middleware: ElicitationMiddleware): this {
        this._elicitationMiddleware.push(middleware);
        return this;
    }

    /**
     * Executes the middleware chain for an outgoing tool call.
     */
    async executeToolCall(ctx: ToolCallContext, handler: (params?: unknown) => Promise<CallToolResult>): Promise<CallToolResult> {
        return this._executeChain(
            ctx,
            [
                ...this._adaptToTyped<ToolCallContext, CallToolResult>(this._universalMiddleware),
                ...this._adaptToTyped<ToolCallContext, CallToolResult>(this._outgoingMiddleware as unknown as ClientMiddleware[]),
                ...this._toolCallMiddleware
            ],
            handler
        );
    }

    /**
     * Executes the middleware chain for an outgoing resource read.
     */
    async executeResourceRead(
        ctx: ResourceReadContext,
        handler: (params?: unknown) => Promise<ReadResourceResult>
    ): Promise<ReadResourceResult> {
        return this._executeChain(
            ctx,
            [
                ...this._adaptToTyped<ResourceReadContext, ReadResourceResult>(this._universalMiddleware),
                ...this._adaptToTyped<ResourceReadContext, ReadResourceResult>(this._outgoingMiddleware as unknown as ClientMiddleware[]),
                ...this._resourceReadMiddleware
            ],
            handler
        );
    }

    /**
     * Executes the middleware chain for an incoming sampling request.
     */
    async executeSampling(ctx: SamplingContext, handler: (params?: unknown) => Promise<CreateMessageResult>): Promise<CreateMessageResult> {
        return this._executeChain(
            ctx,
            [
                ...this._adaptToTyped<SamplingContext, CreateMessageResult>(this._universalMiddleware),
                ...this._adaptToTyped<SamplingContext, CreateMessageResult>(this._incomingMiddleware as unknown as ClientMiddleware[]),
                ...this._samplingMiddleware
            ],
            handler
        );
    }

    /**
     * Executes the middleware chain for an incoming elicitation request.
     */
    async executeElicitation(ctx: ElicitationContext, handler: (params?: unknown) => Promise<ElicitResult>): Promise<ElicitResult> {
        return this._executeChain(
            ctx,
            [
                ...this._adaptToTyped<ElicitationContext, ElicitResult>(this._universalMiddleware),
                ...this._adaptToTyped<ElicitationContext, ElicitResult>(this._incomingMiddleware as unknown as ClientMiddleware[]),
                ...this._elicitationMiddleware
            ],
            handler
        );
    }

    /**
     * Executes the middleware chain for a generic outgoing request.
     */
    async executeOutgoing<T>(ctx: OutgoingContext, handler: (params?: unknown) => Promise<T>): Promise<T> {
        return this._executeChain(
            ctx,
            [
                ...this._adaptToTyped<OutgoingContext, T>(this._universalMiddleware),
                ...this._adaptToTyped<OutgoingContext, T>(this._outgoingMiddleware as unknown as ClientMiddleware[])
            ],
            handler
        );
    }

    /**
     * Executes the middleware chain for a generic incoming request.
     */
    async executeIncoming<T>(ctx: IncomingContext, handler: (params?: unknown) => Promise<T>): Promise<T> {
        return this._executeChain(
            ctx,
            [
                ...this._adaptToTyped<IncomingContext, T>(this._universalMiddleware),
                ...this._adaptToTyped<IncomingContext, T>(this._incomingMiddleware as unknown as ClientMiddleware[])
            ],
            handler
        );
    }

    /**
     * Checks if any middleware is registered.
     */
    hasMiddleware(): boolean {
        return (
            this._universalMiddleware.length > 0 ||
            this._outgoingMiddleware.length > 0 ||
            this._incomingMiddleware.length > 0 ||
            this._toolCallMiddleware.length > 0 ||
            this._resourceReadMiddleware.length > 0 ||
            this._samplingMiddleware.length > 0 ||
            this._elicitationMiddleware.length > 0
        );
    }

    /**
     * Clears all registered middleware.
     */
    clear(): void {
        this._universalMiddleware = [];
        this._outgoingMiddleware = [];
        this._incomingMiddleware = [];
        this._toolCallMiddleware = [];
        this._resourceReadMiddleware = [];
        this._samplingMiddleware = [];
        this._elicitationMiddleware = [];
    }

    /**
     * Adapts generic middleware to a typed middleware.
     */
    private _adaptToTyped<TCtx extends ClientContext, TResult>(
        middlewares: ClientMiddleware[]
    ): Array<(ctx: TCtx, next: ClientNextFn<TResult>) => Promise<TResult>> {
        return middlewares.map(mw => {
            return async (ctx: TCtx, next: ClientNextFn<TResult>): Promise<TResult> => {
                return (await mw(ctx, next as ClientNextFn<unknown>)) as TResult;
            };
        });
    }

    /**
     * Executes a chain of middleware.
     */
    private async _executeChain<TCtx extends ClientContext, TResult>(
        ctx: TCtx,
        middlewares: Array<(ctx: TCtx, next: ClientNextFn<TResult>) => Promise<TResult>>,
        handler: (params?: unknown) => Promise<TResult>
    ): Promise<TResult> {
        let index = -1;
        let currentParams: unknown = ctx.params;

        const dispatch = async (i: number, params?: unknown): Promise<TResult> => {
            if (i <= index) {
                throw new Error('next() called multiple times');
            }
            index = i;
            if (params !== undefined) {
                currentParams = params;
            }

            if (i >= middlewares.length) {
                return handler(currentParams);
            }

            const middleware = middlewares[i];
            if (!middleware) {
                return handler(currentParams);
            }
            return middleware(ctx, (modifiedParams?: unknown) => dispatch(i + 1, modifiedParams));
        };

        return dispatch(0);
    }
}
