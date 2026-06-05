import type { JSONRPCNotification, JSONRPCRequest, Result } from '../types/index.js';
import type { BaseContext } from './protocol.js';

export type RequestHandlerFn<ContextT> = (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

export type NotificationHandlerFn = (notification: JSONRPCNotification) => Promise<void>;

/**
 * Shared storage for JSON-RPC request and notification handlers.
 */
export class HandlerRegistry<ContextT extends BaseContext = BaseContext> {
    private _requestHandlers = new Map<string, RequestHandlerFn<ContextT>>();
    private _notificationHandlers = new Map<string, NotificationHandlerFn>();

    getRequestHandler(method: string): RequestHandlerFn<ContextT> | undefined {
        return this._requestHandlers.get(method);
    }

    setRequestHandler(method: string, handler: RequestHandlerFn<ContextT>): void {
        this._requestHandlers.set(method, handler);
    }

    removeRequestHandler(method: string): void {
        this._requestHandlers.delete(method);
    }

    hasRequestHandler(method: string): boolean {
        return this._requestHandlers.has(method);
    }

    getNotificationHandler(method: string): NotificationHandlerFn | undefined {
        return this._notificationHandlers.get(method);
    }

    setNotificationHandler(method: string, handler: NotificationHandlerFn): void {
        this._notificationHandlers.set(method, handler);
    }

    removeNotificationHandler(method: string): void {
        this._notificationHandlers.delete(method);
    }

    hasNotificationHandler(method: string): boolean {
        return this._notificationHandlers.has(method);
    }
}
