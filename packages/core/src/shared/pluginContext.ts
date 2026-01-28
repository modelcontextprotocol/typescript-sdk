/**
 * Plugin Context Implementation
 *
 * This module provides the concrete implementations of the plugin context interfaces.
 * These are internal to the SDK and are created by Protocol for plugin installation.
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
import type {
    PluginContext,
    PluginHandlerExtra,
    PluginHandlersInterface,
    PluginRequestOptions,
    PluginRequestsInterface,
    PluginResolversInterface,
    PluginTransportInterface
} from './plugin.js';
import type { ProgressManagerInterface } from './progressManager.js';
import type { Transport, TransportSendOptions } from './transport.js';

/**
 * Protocol interface for plugin context creation.
 * This avoids circular dependency with Protocol.
 */
export interface PluginHostProtocol<SendResultT extends Result = Result> {
    readonly transport?: Transport;
    request<T extends AnyObjectSchema>(request: JSONRPCRequest, resultSchema: T, options?: PluginRequestOptions): Promise<SchemaOutput<T>>;
    setRequestHandler<T extends AnyObjectSchema>(
        schema: T,
        handler: (
            request: SchemaOutput<T>,
            ctx: { mcpCtx: { requestId: RequestId; sessionId?: string }; requestCtx: { signal: AbortSignal } }
        ) => SendResultT | Promise<SendResultT>
    ): void;
    setNotificationHandler<T extends AnyObjectSchema>(schema: T, handler: (notification: SchemaOutput<T>) => void | Promise<void>): void;
    removeRequestHandler(method: string): void;
    removeNotificationHandler(method: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Transport Access Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Implementation of PluginTransportInterface.
 * Provides transport-related operations to plugins.
 */
export class PluginTransport implements PluginTransportInterface {
    constructor(private readonly getTransportFn: () => Transport | undefined) {}

    getTransport(): Transport | undefined {
        return this.getTransportFn();
    }

    getSessionId(): string | undefined {
        return this.getTransportFn()?.sessionId;
    }

    async send(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): Promise<void> {
        await this.getTransportFn()?.send(message, options);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Requests Access Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Implementation of PluginRequestsInterface.
 * Allows plugins to make outbound requests.
 */
export class PluginRequests<SendResultT extends Result = Result> implements PluginRequestsInterface {
    constructor(private readonly protocol: PluginHostProtocol<SendResultT>) {}

    async sendRequest<T extends AnyObjectSchema>(
        request: JSONRPCRequest,
        resultSchema: T,
        options?: PluginRequestOptions
    ): Promise<SchemaOutput<T>> {
        return this.protocol.request(request, resultSchema, options);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Handler Registry Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Implementation of PluginHandlersInterface.
 * Allows plugins to register request and notification handlers.
 */
export class PluginHandlers<SendResultT extends Result = Result> implements PluginHandlersInterface<SendResultT> {
    constructor(private readonly protocol: PluginHostProtocol<SendResultT>) {}

    setRequestHandler<T extends AnyObjectSchema>(
        schema: T,
        handler: (request: SchemaOutput<T>, extra: PluginHandlerExtra) => SendResultT | Promise<SendResultT>
    ): void {
        this.protocol.setRequestHandler(schema, (parsedRequest, ctx) => {
            const pluginExtra: PluginHandlerExtra = {
                mcpCtx: {
                    requestId: ctx.mcpCtx.requestId,
                    sessionId: ctx.mcpCtx.sessionId
                },
                requestCtx: {
                    signal: ctx.requestCtx.signal
                }
            };
            return handler(parsedRequest, pluginExtra);
        });
    }

    setNotificationHandler<T extends AnyObjectSchema>(schema: T, handler: (notification: SchemaOutput<T>) => void | Promise<void>): void {
        this.protocol.setNotificationHandler(schema, handler);
    }

    removeRequestHandler(method: string): void {
        this.protocol.removeRequestHandler(method);
    }

    removeNotificationHandler(method: string): void {
        this.protocol.removeNotificationHandler(method);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Request Resolver Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Implementation of PluginResolversInterface.
 * Manages request resolvers for routing queued responses.
 */
export class PluginResolvers implements PluginResolversInterface {
    constructor(private readonly resolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void>) {}

    register(id: RequestId, resolver: (response: JSONRPCResultResponse | Error) => void): void {
        this.resolvers.set(id, resolver);
    }

    get(id: RequestId): ((response: JSONRPCResultResponse | Error) => void) | undefined {
        return this.resolvers.get(id);
    }

    remove(id: RequestId): void {
        this.resolvers.delete(id);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for creating a PluginContext.
 */
export interface PluginContextConfig<SendResultT extends Result = Result> {
    protocol: PluginHostProtocol<SendResultT>;
    getTransport: () => Transport | undefined;
    resolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void>;
    progressManager: ProgressManagerInterface;
    reportError: (error: Error) => void;
}

/**
 * Creates a PluginContext from the given configuration.
 * This is called once by Protocol and cached for reuse.
 */
export function createPluginContext<SendResultT extends Result = Result>(
    config: PluginContextConfig<SendResultT>
): PluginContext<SendResultT> {
    return {
        transport: new PluginTransport(config.getTransport),
        requests: new PluginRequests(config.protocol),
        handlers: new PluginHandlers(config.protocol),
        resolvers: new PluginResolvers(config.resolvers),
        progress: config.progressManager,
        reportError: config.reportError
    };
}
