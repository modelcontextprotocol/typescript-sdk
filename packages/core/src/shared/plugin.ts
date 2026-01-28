/**
 * Protocol Plugin System
 *
 * This module defines the plugin interface for extending Protocol functionality.
 * Plugins are INTERNAL to the SDK - they are used for decomposing the Protocol class
 * into focused components. They are not exposed as a public API for SDK users.
 *
 * For application-level extensibility (logging, auth, metrics), SDK users should
 * use McpServer Middleware (see server/middleware.ts) or Client Middleware.
 */

import type {
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    RequestId,
    Result
} from '../types/types.js';
import type { AnyObjectSchema, SchemaOutput } from '../util/zodCompat.js';
import type { ProgressManagerInterface } from './progressManager.js';
import type { Transport, TransportSendOptions } from './transport.js';

// ═══════════════════════════════════════════════════════════════════════════
// Sub-Component Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Interface for transport-related operations accessible to plugins.
 */
export interface PluginTransportInterface {
    /**
     * Get the current transport (may be undefined if not connected)
     */
    getTransport(): Transport | undefined;

    /**
     * Get the session ID (if available)
     */
    getSessionId(): string | undefined;

    /**
     * Send a message through the transport
     */
    send(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): Promise<void>;
}

/**
 * Interface for making outbound requests from plugins.
 */
export interface PluginRequestsInterface {
    /**
     * Send a request through the protocol and wait for a response.
     *
     * @param request - The request to send
     * @param resultSchema - Schema to validate the response
     * @param options - Optional request options (timeout, signal, etc.)
     * @returns The validated response
     */
    sendRequest<T extends AnyObjectSchema>(
        request: JSONRPCRequest,
        resultSchema: T,
        options?: PluginRequestOptions
    ): Promise<SchemaOutput<T>>;
}

/**
 * Interface for registering and managing handlers.
 */
export interface PluginHandlersInterface<SendResultT extends Result = Result> {
    /**
     * Register a request handler for a specific method.
     * Handler returns SendResultT to ensure type safety with the Protocol.
     */
    setRequestHandler<T extends AnyObjectSchema>(
        schema: T,
        handler: (request: SchemaOutput<T>, extra: PluginHandlerExtra) => SendResultT | Promise<SendResultT>
    ): void;

    /**
     * Register a notification handler for a specific method
     */
    setNotificationHandler<T extends AnyObjectSchema>(schema: T, handler: (notification: SchemaOutput<T>) => void | Promise<void>): void;

    /**
     * Remove a request handler
     */
    removeRequestHandler(method: string): void;

    /**
     * Remove a notification handler
     */
    removeNotificationHandler(method: string): void;
}

/**
 * Interface for managing request resolvers.
 * Used by TaskPlugin for routing queued responses back to their original callers.
 */
export interface PluginResolversInterface {
    /**
     * Register a resolver for a pending request.
     */
    register(id: RequestId, resolver: (response: JSONRPCResultResponse | Error) => void): void;

    /**
     * Get a resolver for a pending request.
     */
    get(id: RequestId): ((response: JSONRPCResultResponse | Error) => void) | undefined;

    /**
     * Remove a resolver for a pending request.
     */
    remove(id: RequestId): void;
}

/**
 * Options for plugin requests.
 */
export interface PluginRequestOptions {
    /**
     * Timeout in milliseconds for the request
     */
    timeout?: number;

    /**
     * Abort signal for cancelling the request
     */
    signal?: AbortSignal;

    /** Allow additional options */
    [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// Plugin Context
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Context provided to plugins during installation.
 * Composed of focused sub-components for different concerns.
 */
export interface PluginContext<SendResultT extends Result = Result> {
    /**
     * Transport operations (get transport, send messages)
     */
    readonly transport: PluginTransportInterface;

    /**
     * Outbound request operations
     */
    readonly requests: PluginRequestsInterface;

    /**
     * Handler registration and management
     */
    readonly handlers: PluginHandlersInterface<SendResultT>;

    /**
     * Request resolver management (for task response routing)
     */
    readonly resolvers: PluginResolversInterface;

    /**
     * Progress handler management
     */
    readonly progress: ProgressManagerInterface;

    /**
     * Report an error through the protocol's error handling
     */
    reportError(error: Error): void;
}

/**
 * Extra context passed to plugin request handlers.
 */
export interface PluginHandlerExtra {
    /**
     * MCP context with request metadata
     */
    readonly mcpCtx: {
        readonly requestId: RequestId;
        readonly sessionId?: string;
    };

    /**
     * Request context with abort signal
     */
    readonly requestCtx: {
        readonly signal: AbortSignal;
    };
}

/**
 * Context provided to plugin hooks during request processing.
 */
export interface RequestContext {
    /**
     * The session ID for this request
     */
    readonly sessionId?: string;

    /**
     * The request ID from the JSON-RPC message
     */
    readonly requestId: number | string;

    /**
     * The method being called
     */
    readonly method: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Protocol Plugin Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Plugin interface for extending Protocol functionality.
 *
 * Plugins are internal SDK components for decomposing the Protocol class.
 * They can:
 * - Register handlers during installation
 * - Hook into request/response lifecycle
 * - Route messages (e.g., for task queueing)
 *
 * Note: Plugins are NOT a public API for SDK users. For application-level
 * extensibility, use McpServer/Client middleware instead.
 */
export interface ProtocolPlugin<SendResultT extends Result = Result> {
    /**
     * Unique name for this plugin (for debugging and identification)
     */
    readonly name: string;

    /**
     * Priority determines execution order. Higher priority = runs first.
     * Default: 0
     */
    readonly priority?: number;

    // ─── LIFECYCLE HOOKS ───

    /**
     * Called when the plugin is installed on a Protocol instance.
     * Use this to register handlers, set up state, etc.
     */
    install?(ctx: PluginContext<SendResultT>): void | Promise<void>;

    /**
     * Called when a transport is connected.
     */
    onConnect?(transport: Transport): void | Promise<void>;

    /**
     * Called when the connection is closed.
     */
    onClose?(): void | Promise<void>;

    // ─── MESSAGE ROUTING ───

    /**
     * Determines if this plugin should route the message instead of the default transport.
     * Used by TaskPlugin to queue messages for task-related responses.
     */
    shouldRouteMessage?(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): boolean;

    /**
     * Routes the message. Only called if shouldRouteMessage returned true.
     */
    routeMessage?(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): Promise<void>;

    // ─── REQUEST/RESPONSE HOOKS ───

    /**
     * Called before a request is processed.
     * Can modify the request or return void to pass through unchanged.
     */
    onRequest?(request: JSONRPCRequest, ctx: RequestContext): JSONRPCRequest | void | Promise<JSONRPCRequest | void>;

    /**
     * Called after a request is successfully processed.
     * Can modify the result or return void to pass through unchanged.
     */
    onRequestResult?(request: JSONRPCRequest, result: Result, ctx: RequestContext): Result | void | Promise<Result | void>;

    /**
     * Called when a request handler throws an error.
     * Can modify the error or return void to pass through unchanged.
     */
    onRequestError?(request: JSONRPCRequest, error: Error, ctx: RequestContext): Error | void | Promise<Error | void>;

    /**
     * Called when a response is received (for outgoing requests).
     * Plugins can use this to manage progress handlers or other state.
     * @param response - The response received
     * @param messageId - The message ID (progress token) for this request
     */
    onResponse?(response: JSONRPCResponse | JSONRPCErrorResponse, messageId: number): void | Promise<void>;

    // ─── NOTIFICATION HOOKS ───

    /**
     * Called before a notification is processed.
     * Can modify the notification or return void to pass through unchanged.
     */
    onNotification?(notification: JSONRPCNotification): JSONRPCNotification | void | Promise<JSONRPCNotification | void>;

    // ─── OUTGOING MESSAGE HOOKS ───

    /**
     * Called before sending an outgoing request.
     * Plugins can augment request params (e.g., add task metadata) or register response resolvers.
     * @param request - The request being sent (can be mutated)
     * @param options - The request options (can be mutated)
     * @returns Modified request, or void to use original
     */
    onBeforeSendRequest?(request: JSONRPCRequest, options: OutgoingRequestContext): JSONRPCRequest | void | Promise<JSONRPCRequest | void>;

    /**
     * Called before sending an outgoing notification.
     * Plugins can augment notification params (e.g., add task metadata).
     * @param notification - The notification being sent (can be mutated)
     * @param options - The notification options (can be mutated)
     * @returns Modified notification, or void to use original
     */
    onBeforeSendNotification?(
        notification: JSONRPCNotification,
        options: OutgoingNotificationContext
    ): JSONRPCNotification | void | Promise<JSONRPCNotification | void>;

    // ─── HANDLER CONTEXT HOOKS ───

    /**
     * Called when building context for an incoming request handler.
     * Plugins can contribute additional context (e.g., task context).
     * @param request - The incoming request
     * @param baseContext - Base context with session info
     * @returns Additional context fields to merge, or void
     */
    onBuildHandlerContext?(
        request: JSONRPCRequest,
        baseContext: HandlerContextBase
    ): Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
}

/**
 * Context passed to onBeforeSendRequest hook.
 */
export interface OutgoingRequestContext {
    /** Message ID for this request */
    readonly messageId: number;
    /** Session ID if available */
    readonly sessionId?: string;
    /** Original request options (plugins can read task, relatedTask, etc.) */
    readonly requestOptions?: Record<string, unknown>;
    /** Register a resolver to handle the response */
    registerResolver(resolver: (response: JSONRPCResultResponse | Error) => void): void;
}

/**
 * Context passed to onBeforeSendNotification hook.
 */
export interface OutgoingNotificationContext {
    /** Session ID if available */
    readonly sessionId?: string;
    /** Related request ID if this notification is in response to a request */
    readonly relatedRequestId?: RequestId;
    /** Original notification options (plugins can read relatedTask, etc.) */
    readonly notificationOptions?: Record<string, unknown>;
}

/**
 * Base context passed to onBuildHandlerContext hook.
 */
export interface HandlerContextBase {
    /** Session ID if available */
    readonly sessionId?: string;
    /** The incoming request */
    readonly request: JSONRPCRequest;
}

// ═══════════════════════════════════════════════════════════════════════════
// Base Plugin Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Abstract base class for plugins.
 * Provides default no-op implementations for all hooks.
 * Plugins only need to override the methods they care about.
 */
export abstract class BasePlugin<SendResultT extends Result = Result> implements ProtocolPlugin<SendResultT> {
    abstract readonly name: string;
    readonly priority?: number;

    // Default no-op implementations
    install?(_ctx: PluginContext<SendResultT>): void | Promise<void> {
        // Override in subclass
    }

    onConnect?(_transport: Transport): void | Promise<void> {
        // Override in subclass
    }

    onClose?(): void | Promise<void> {
        // Override in subclass
    }

    shouldRouteMessage?(
        _message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        _options?: TransportSendOptions
    ): boolean {
        return false;
    }

    routeMessage?(
        _message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        _options?: TransportSendOptions
    ): Promise<void> {
        return Promise.resolve();
    }

    onRequest?(_request: JSONRPCRequest, _ctx: RequestContext): JSONRPCRequest | void | Promise<JSONRPCRequest | void> {
        // Override in subclass
    }

    onRequestResult?(_request: JSONRPCRequest, _result: Result, _ctx: RequestContext): Result | void | Promise<Result | void> {
        // Override in subclass
    }

    onRequestError?(_request: JSONRPCRequest, _error: Error, _ctx: RequestContext): Error | void | Promise<Error | void> {
        // Override in subclass
    }

    onResponse?(_response: JSONRPCResponse | JSONRPCErrorResponse, _messageId: number): void | Promise<void> {
        // Override in subclass
    }

    onNotification?(_notification: JSONRPCNotification): JSONRPCNotification | void | Promise<JSONRPCNotification | void> {
        // Override in subclass
    }

    onBeforeSendRequest?(
        _request: JSONRPCRequest,
        _options: OutgoingRequestContext
    ): JSONRPCRequest | void | Promise<JSONRPCRequest | void> {
        // Override in subclass
    }

    onBeforeSendNotification?(
        _notification: JSONRPCNotification,
        _options: OutgoingNotificationContext
    ): JSONRPCNotification | void | Promise<JSONRPCNotification | void> {
        // Override in subclass
    }

    onBuildHandlerContext?(
        _request: JSONRPCRequest,
        _baseContext: HandlerContextBase
    ): Record<string, unknown> | void | Promise<Record<string, unknown> | void> {
        // Override in subclass
    }
}

/**
 * Helper function to sort plugins by priority (higher priority first)
 */
export function sortPluginsByPriority<P extends ProtocolPlugin>(plugins: P[]): P[] {
    return plugins.toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
