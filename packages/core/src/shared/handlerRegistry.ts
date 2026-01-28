/**
 * Handler Registry
 *
 * Manages request and notification handlers for the Protocol class.
 * Extracted from Protocol to follow Single Responsibility Principle.
 *
 * This registry is focused on storage and management - it does NOT handle:
 * - Schema parsing (handled by Protocol)
 * - Capability assertions (handled by Protocol)
 */

import type { JSONRPCNotification, JSONRPCRequest, Notification, Request, RequestId, Result } from '../types/types.js';
import type { BaseRequestContext, ContextInterface } from './context.js';

/**
 * Internal handler type for request handlers (after parsing by Protocol)
 */
export type InternalRequestHandler<SendRequestT extends Request, SendNotificationT extends Notification, SendResultT extends Result> = (
    request: JSONRPCRequest,
    extra: ContextInterface<SendRequestT, SendNotificationT, BaseRequestContext>
) => Promise<SendResultT>;

/**
 * Internal notification handler type (after parsing by Protocol)
 */
export type InternalNotificationHandler = (notification: JSONRPCNotification) => Promise<void>;

/**
 * Manages request and notification handlers for the Protocol.
 * Focused on storage, retrieval, and abort controller management.
 */
export class HandlerRegistry<SendRequestT extends Request, SendNotificationT extends Notification, SendResultT extends Result> {
    private _requestHandlers = new Map<string, InternalRequestHandler<SendRequestT, SendNotificationT, SendResultT>>();
    private _notificationHandlers = new Map<string, InternalNotificationHandler>();
    private _requestHandlerAbortControllers = new Map<RequestId, AbortController>();

    /**
     * A handler to invoke for any request types that do not have their own handler installed.
     */
    fallbackRequestHandler?: InternalRequestHandler<SendRequestT, SendNotificationT, SendResultT>;

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    fallbackNotificationHandler?: (notification: Notification) => Promise<void>;

    // ═══════════════════════════════════════════════════════════════════════════
    // Request Handler Management
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Sets a request handler for a method.
     * The handler should already be wrapped to handle JSONRPCRequest.
     */
    setRequestHandler(method: string, handler: InternalRequestHandler<SendRequestT, SendNotificationT, SendResultT>): void {
        this._requestHandlers.set(method, handler);
    }

    /**
     * Gets a request handler for a method, or the fallback handler if none exists.
     */
    getRequestHandler(method: string): InternalRequestHandler<SendRequestT, SendNotificationT, SendResultT> | undefined {
        return this._requestHandlers.get(method) ?? this.fallbackRequestHandler;
    }

    /**
     * Checks if a request handler exists for a method.
     */
    hasRequestHandler(method: string): boolean {
        return this._requestHandlers.has(method);
    }

    /**
     * Removes a request handler for a method.
     */
    removeRequestHandler(method: string): void {
        this._requestHandlers.delete(method);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Notification Handler Management
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Sets a notification handler for a method.
     * The handler should already be wrapped to handle JSONRPCNotification.
     */
    setNotificationHandler(method: string, handler: InternalNotificationHandler): void {
        this._notificationHandlers.set(method, handler);
    }

    /**
     * Gets a notification handler for a method, or the fallback handler if none exists.
     */
    getNotificationHandler(method: string): InternalNotificationHandler | undefined {
        const handler = this._notificationHandlers.get(method);
        if (handler) return handler;
        // Wrap fallback to match InternalNotificationHandler signature
        if (this.fallbackNotificationHandler) {
            return async (notification: JSONRPCNotification) => {
                await this.fallbackNotificationHandler!(notification as Notification);
            };
        }
        return undefined;
    }

    /**
     * Checks if a notification handler exists for a method.
     */
    hasNotificationHandler(method: string): boolean {
        return this._notificationHandlers.has(method);
    }

    /**
     * Removes a notification handler for a method.
     */
    removeNotificationHandler(method: string): void {
        this._notificationHandlers.delete(method);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Abort Controller Management
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Creates an AbortController for a request and stores it.
     */
    createAbortController(requestId: RequestId): AbortController {
        const controller = new AbortController();
        this._requestHandlerAbortControllers.set(requestId, controller);
        return controller;
    }

    /**
     * Gets the AbortController for a request.
     */
    getAbortController(requestId: RequestId): AbortController | undefined {
        return this._requestHandlerAbortControllers.get(requestId);
    }

    /**
     * Removes the AbortController for a request.
     */
    removeAbortController(requestId: RequestId): void {
        this._requestHandlerAbortControllers.delete(requestId);
    }

    /**
     * Aborts all pending request handlers.
     */
    abortAllPendingRequests(reason?: string): void {
        for (const controller of this._requestHandlerAbortControllers.values()) {
            controller.abort(reason);
        }
        this._requestHandlerAbortControllers.clear();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Utility Methods
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Gets all registered request handler methods.
     */
    getRequestMethods(): string[] {
        return [...this._requestHandlers.keys()];
    }

    /**
     * Gets all registered notification handler methods.
     */
    getNotificationMethods(): string[] {
        return [...this._notificationHandlers.keys()];
    }

    /**
     * Clears all handlers and abort controllers.
     */
    clear(): void {
        this._requestHandlers.clear();
        this._notificationHandlers.clear();
        this.abortAllPendingRequests('Registry cleared');
    }
}
