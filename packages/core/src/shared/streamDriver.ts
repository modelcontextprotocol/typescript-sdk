import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type {
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    MessageExtraInfo,
    Notification,
    Progress,
    ProgressNotification,
    Request,
    RequestId,
    Result
} from '../types/index.js';
import {
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    ProtocolError,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types/index.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import { parseSchema } from '../util/schema.js';
import type { DispatchEnv, Dispatcher } from './dispatcher.js';
import { getResultSchema } from './dispatcher.js';
import type { NotificationOptions, ProgressCallback, RequestOptions } from './protocol.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from './protocol.js';
import type { Transport } from './transport.js';

type TimeoutInfo = {
    timeoutId: ReturnType<typeof setTimeout>;
    startTime: number;
    timeout: number;
    maxTotalTimeout?: number;
    resetTimeoutOnProgress: boolean;
    onTimeout: () => void;
};

export type StreamDriverOptions = {
    supportedProtocolVersions?: string[];
    debouncedNotificationMethods?: string[];
    /**
     * Hook to enrich the per-request {@linkcode DispatchEnv} from transport-supplied
     * {@linkcode MessageExtraInfo} (e.g. auth, http req).
     */
    buildEnv?: (extra: MessageExtraInfo | undefined, base: DispatchEnv) => DispatchEnv;
};

/**
 * Runs a {@linkcode Dispatcher} over a persistent bidirectional {@linkcode Transport}
 * (stdio, WebSocket, InMemory). Owns all per-connection state: outbound request
 * id correlation, timeouts, progress callbacks, cancellation, debouncing.
 *
 * One driver per pipe. The dispatcher it wraps may be shared.
 */
export class StreamDriver {
    private _requestMessageId = 0;
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();
    private _supportedProtocolVersions: string[];

    onclose?: () => void;
    onerror?: (error: Error) => void;

    constructor(
        readonly dispatcher: Dispatcher<any>,
        readonly pipe: Transport,
        private _options: StreamDriverOptions = {}
    ) {
        this._supportedProtocolVersions = _options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    }

    /**
     * Wires the pipe's callbacks and starts it. After this resolves, inbound
     * requests are dispatched and {@linkcode StreamDriver.request | request()} works.
     */
    async start(): Promise<void> {
        const prevClose = this.pipe.onclose;
        this.pipe.onclose = () => {
            try {
                prevClose?.();
            } finally {
                this._onclose();
            }
        };

        const prevError = this.pipe.onerror;
        this.pipe.onerror = (error: Error) => {
            prevError?.(error);
            this._onerror(error);
        };

        const prevMessage = this.pipe.onmessage;
        this.pipe.onmessage = (message, extra) => {
            prevMessage?.(message, extra);
            if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
                this._onresponse(message);
            } else if (isJSONRPCRequest(message)) {
                this._onrequest(message, extra);
            } else if (isJSONRPCNotification(message)) {
                this._onnotification(message);
            } else {
                this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
            }
        };

        this.pipe.setSupportedProtocolVersions?.(this._supportedProtocolVersions);
        await this.pipe.start();
    }

    async close(): Promise<void> {
        await this.pipe.close();
    }

    /**
     * Sends a request over the pipe and resolves with the parsed result.
     */
    request<T extends AnySchema>(req: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken } = options ?? {};
        let onAbort: (() => void) | undefined;
        let cleanupId: number | undefined;

        return new Promise<SchemaOutput<T>>((resolve, reject) => {
            options?.signal?.throwIfAborted();

            const messageId = this._requestMessageId++;
            cleanupId = messageId;
            const jsonrpcRequest: JSONRPCRequest = { ...req, jsonrpc: '2.0', id: messageId };

            if (options?.onprogress) {
                this._progressHandlers.set(messageId, options.onprogress);
                jsonrpcRequest.params = {
                    ...req.params,
                    _meta: { ...(req.params?._meta as Record<string, unknown> | undefined), progressToken: messageId }
                };
            }

            const cancel = (reason: unknown) => {
                this._progressHandlers.delete(messageId);
                this.pipe
                    .send(
                        {
                            jsonrpc: '2.0',
                            method: 'notifications/cancelled',
                            params: { requestId: messageId, reason: String(reason) }
                        },
                        { relatedRequestId, resumptionToken, onresumptiontoken }
                    )
                    .catch(error => this._onerror(new Error(`Failed to send cancellation: ${error}`)));
                const error = reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
                reject(error);
            };

            this._responseHandlers.set(messageId, response => {
                if (options?.signal?.aborted) return;
                if (response instanceof Error) return reject(response);
                try {
                    const parsed = parseSchema(resultSchema, response.result);
                    if (parsed.success) resolve(parsed.data as SchemaOutput<T>);
                    else reject(parsed.error);
                } catch (error) {
                    reject(error);
                }
            });

            onAbort = () => cancel(options?.signal?.reason);
            options?.signal?.addEventListener('abort', onAbort, { once: true });

            const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
            this._setupTimeout(
                messageId,
                timeout,
                options?.maxTotalTimeout,
                () => cancel(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout })),
                options?.resetTimeoutOnProgress ?? false
            );

            this.pipe.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch(error => {
                this._progressHandlers.delete(messageId);
                reject(error);
            });
        }).finally(() => {
            if (onAbort) options?.signal?.removeEventListener('abort', onAbort);
            if (cleanupId !== undefined) {
                this._responseHandlers.delete(cleanupId);
                this._cleanupTimeout(cleanupId);
            }
        });
    }

    /**
     * Sends a notification over the pipe. Supports debouncing per the constructor option.
     */
    async notification(notification: Notification, options?: NotificationOptions): Promise<void> {
        const jsonrpc: JSONRPCNotification = { jsonrpc: '2.0', method: notification.method, params: notification.params };

        const debounced = this._options.debouncedNotificationMethods ?? [];
        const canDebounce = debounced.includes(notification.method) && !notification.params && !options?.relatedRequestId;
        if (canDebounce) {
            if (this._pendingDebouncedNotifications.has(notification.method)) return;
            this._pendingDebouncedNotifications.add(notification.method);
            Promise.resolve().then(() => {
                this._pendingDebouncedNotifications.delete(notification.method);
                this.pipe.send(jsonrpc, options).catch(error => this._onerror(error));
            });
            return;
        }
        await this.pipe.send(jsonrpc, options);
    }

    private _onrequest(request: JSONRPCRequest, extra?: MessageExtraInfo): void {
        const abort = new AbortController();
        this._requestHandlerAbortControllers.set(request.id, abort);

        const baseEnv: DispatchEnv = {
            signal: abort.signal,
            sessionId: this.pipe.sessionId,
            authInfo: extra?.authInfo,
            httpReq: extra?.request,
            send: (r, opts) => this.request(r, getResultSchema(r.method as any), { ...opts, relatedRequestId: request.id }) as Promise<Result>
        };
        const env = this._options.buildEnv ? this._options.buildEnv(extra, baseEnv) : baseEnv;

        const drain = async () => {
            for await (const out of this.dispatcher.dispatch(request, env)) {
                if (abort.signal.aborted && out.kind === 'response') return;
                await this.pipe.send(out.message, { relatedRequestId: request.id });
            }
        };
        drain()
            .catch(error => this._onerror(new Error(`Failed to send response: ${error}`)))
            .finally(() => {
                if (this._requestHandlerAbortControllers.get(request.id) === abort) {
                    this._requestHandlerAbortControllers.delete(request.id);
                }
            });
    }

    private _onnotification(notification: JSONRPCNotification): void {
        if (notification.method === 'notifications/cancelled') {
            const requestId = (notification.params as { requestId?: RequestId } | undefined)?.requestId;
            if (requestId !== undefined) this._requestHandlerAbortControllers.get(requestId)?.abort((notification.params as any)?.reason);
            return;
        }
        if (notification.method === 'notifications/progress') {
            this._onprogress(notification as unknown as ProgressNotification);
            return;
        }
        this.dispatcher
            .dispatchNotification(notification)
            .catch(error => this._onerror(new Error(`Uncaught error in notification handler: ${error}`)));
    }

    private _onprogress(notification: ProgressNotification): void {
        const { progressToken, ...params } = notification.params;
        const messageId = Number(progressToken);
        const handler = this._progressHandlers.get(messageId);
        if (!handler) {
            this._onerror(new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
            return;
        }
        const responseHandler = this._responseHandlers.get(messageId);
        const info = this._timeoutInfo.get(messageId);
        if (info && responseHandler && info.resetTimeoutOnProgress) {
            try {
                this._resetTimeout(messageId);
            } catch (error) {
                this._responseHandlers.delete(messageId);
                this._progressHandlers.delete(messageId);
                this._cleanupTimeout(messageId);
                responseHandler(error as Error);
                return;
            }
        }
        handler(params as Progress);
    }

    private _onresponse(response: JSONRPCResponse | JSONRPCErrorResponse): void {
        const messageId = Number(response.id);
        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
            return;
        }
        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        this._progressHandlers.delete(messageId);
        if (isJSONRPCResultResponse(response)) {
            handler(response);
        } else {
            handler(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
        }
    }

    private _onclose(): void {
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = new Map();
        this._progressHandlers.clear();
        this._pendingDebouncedNotifications.clear();
        for (const info of this._timeoutInfo.values()) clearTimeout(info.timeoutId);
        this._timeoutInfo.clear();
        const aborts = this._requestHandlerAbortControllers;
        this._requestHandlerAbortControllers = new Map();
        const error = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');
        try {
            this.onclose?.();
        } finally {
            for (const handler of responseHandlers.values()) handler(error);
            for (const c of aborts.values()) c.abort(error);
        }
    }

    private _onerror(error: Error): void {
        this.onerror?.(error);
    }

    private _setupTimeout(id: number, timeout: number, maxTotal: number | undefined, onTimeout: () => void, reset: boolean): void {
        this._timeoutInfo.set(id, {
            timeoutId: setTimeout(onTimeout, timeout),
            startTime: Date.now(),
            timeout,
            maxTotalTimeout: maxTotal,
            resetTimeoutOnProgress: reset,
            onTimeout
        });
    }

    private _resetTimeout(id: number): boolean {
        const info = this._timeoutInfo.get(id);
        if (!info) return false;
        const elapsed = Date.now() - info.startTime;
        if (info.maxTotalTimeout && elapsed >= info.maxTotalTimeout) {
            this._timeoutInfo.delete(id);
            throw new SdkError(SdkErrorCode.RequestTimeout, 'Maximum total timeout exceeded', {
                maxTotalTimeout: info.maxTotalTimeout,
                totalElapsed: elapsed
            });
        }
        clearTimeout(info.timeoutId);
        info.timeoutId = setTimeout(info.onTimeout, info.timeout);
        return true;
    }

    private _cleanupTimeout(id: number): void {
        const info = this._timeoutInfo.get(id);
        if (info) {
            clearTimeout(info.timeoutId);
            this._timeoutInfo.delete(id);
        }
    }
}
