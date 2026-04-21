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
    RequestMethod,
    Result
} from '../types/index.js';
import {
    getResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    ProtocolError,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types/index.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import { parseSchema } from '../util/schema.js';
import type { NotificationOptions, OutboundChannel, ProgressCallback, RequestOptions } from './context.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from './context.js';
import type { DispatchEnv, Dispatcher } from './dispatcher.js';
import type { InboundContext, TaskManagerHost, TaskManagerOptions } from './taskManager.js';
import { NullTaskManager, TaskManager } from './taskManager.js';
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
    /**
     * A pre-constructed and already-bound {@linkcode TaskManager}. When provided the
     * driver uses it directly. When omitted, the driver constructs one from
     * {@linkcode StreamDriverOptions.tasks | tasks} (or a {@linkcode NullTaskManager}) and binds it itself.
     */
    taskManager?: TaskManager;
    tasks?: TaskManagerOptions;
    enforceStrictCapabilities?: boolean;
    /**
     * Set when the dispatcher's {@linkcode Dispatcher.dispatch | dispatch()} override handles
     * {@linkcode TaskManager.processInboundRequest} itself (e.g. {@linkcode McpServer}).
     * When true, the driver skips its own inbound task processing to avoid double-processing.
     */
    dispatcherHandlesTasks?: boolean;
};

/**
 * Runs a {@linkcode Dispatcher} over a persistent bidirectional {@linkcode Transport}
 * (stdio, WebSocket, InMemory). Owns all per-connection state: outbound request
 * id correlation, timeouts, progress callbacks, cancellation, debouncing.
 *
 * One driver per pipe. The dispatcher it wraps may be shared.
 */
export class StreamDriver implements OutboundChannel {
    private _requestMessageId = 0;
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();
    private _closed = false;
    private _supportedProtocolVersions: string[];
    private _taskManager: TaskManager;

    onclose?: () => void;
    onerror?: (error: Error) => void;

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver is context-agnostic; subclass owns ContextT
        readonly dispatcher: Dispatcher<any>,
        readonly pipe: Transport,
        private _options: StreamDriverOptions = {}
    ) {
        this._supportedProtocolVersions = _options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
        if (_options.taskManager) {
            this._taskManager = _options.taskManager;
        } else {
            this._taskManager = _options.tasks ? new TaskManager(_options.tasks) : new NullTaskManager();
            this._bindTaskManager();
        }
    }

    get taskManager(): TaskManager {
        return this._taskManager;
    }

    /** Exposed so a {@linkcode TaskManagerHost} owned outside the driver can clear progress callbacks. */
    removeProgressHandler(token: number): void {
        this._progressHandlers.delete(token);
    }

    private _bindTaskManager(): void {
        const host: TaskManagerHost = {
            request: (r, schema, opts) => this.request(r, schema, opts),
            notification: (n, opts) => this.notification(n, opts),
            reportError: e => this._onerror(e),
            removeProgressHandler: t => this.removeProgressHandler(t),
            registerHandler: (method, handler) => this.dispatcher.setRawRequestHandler(method, handler),
            sendOnResponseStream: async (message, relatedRequestId) => {
                await this.pipe.send(message, { relatedRequestId });
            },
            enforceStrictCapabilities: this._options.enforceStrictCapabilities === true,
            assertTaskCapability: () => {},
            assertTaskHandlerCapability: () => {}
        };
        this._taskManager.bind(host);
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

    /** {@linkcode OutboundChannel.setProtocolVersion} — delegates to the pipe. */
    setProtocolVersion(version: string): void {
        this.pipe.setProtocolVersion?.(version);
    }

    /** {@linkcode OutboundChannel.sendRaw} — write a raw JSON-RPC message to the pipe. */
    async sendRaw(message: Parameters<Transport['send']>[0], options?: { relatedRequestId?: RequestId }): Promise<void> {
        await this.pipe.send(message, options);
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

            const sideChannelResponse = (resp: JSONRPCResultResponse | Error) => {
                const h = this._responseHandlers.get(messageId);
                if (h) h(resp);
                else this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
            };

            let queued = false;
            try {
                queued = this._taskManager.processOutboundRequest(jsonrpcRequest, options, messageId, sideChannelResponse, error => {
                    this._progressHandlers.delete(messageId);
                    reject(error);
                }).queued;
            } catch (error) {
                this._progressHandlers.delete(messageId);
                reject(error);
                return;
            }

            if (!queued) {
                this.pipe.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch(error => {
                    this._progressHandlers.delete(messageId);
                    reject(error);
                });
            }
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
        const taskResult = await this._taskManager.processOutboundNotification(notification, options);
        if (taskResult.queued || this._closed) return;
        const jsonrpc: JSONRPCNotification = taskResult.jsonrpcNotification ?? {
            jsonrpc: '2.0',
            method: notification.method,
            params: notification.params
        };

        const debounced = this._options.debouncedNotificationMethods ?? [];
        const canDebounce =
            debounced.includes(notification.method) && !notification.params && !options?.relatedRequestId && !options?.relatedTask;
        if (canDebounce) {
            if (this._pendingDebouncedNotifications.has(notification.method)) return;
            this._pendingDebouncedNotifications.add(notification.method);
            Promise.resolve().then(() => {
                // If the entry was already removed (by _onclose), skip the send.
                if (!this._pendingDebouncedNotifications.delete(notification.method)) return;
                this.pipe.send(jsonrpc, options).catch(error => this._onerror(error));
            });
            return;
        }
        await this.pipe.send(jsonrpc, options);
    }

    private _onrequest(request: JSONRPCRequest, extra?: MessageExtraInfo): void {
        const abort = new AbortController();
        this._requestHandlerAbortControllers.set(request.id, abort);

        const directSend = (r: Request, opts?: RequestOptions) =>
            this.request(r, getResultSchema(r.method as RequestMethod), { ...opts, relatedRequestId: request.id }) as Promise<Result>;

        let task: DispatchEnv['task'];
        let send = directSend;
        // eslint-disable-next-line unicorn/consistent-function-scoping -- conditionally reassigned below
        let routeResponse = async (_m: JSONRPCResponse | JSONRPCErrorResponse) => false;
        let drainNotification = (n: Notification, opts?: NotificationOptions) =>
            this.notification(n, { ...opts, relatedRequestId: request.id });
        let validateInbound: (() => void) | undefined;

        if (!this._options.dispatcherHandlesTasks) {
            const inboundCtx: InboundContext = {
                sessionId: this.pipe.sessionId,
                sendNotification: drainNotification,
                sendRequest: (r, schema, opts) => this.request(r, schema, { ...opts, relatedRequestId: request.id })
            };
            const taskResult = this._taskManager.processInboundRequest(request, inboundCtx);
            task = taskResult.taskContext;
            send = (r, opts) => taskResult.sendRequest(r, getResultSchema(r.method as RequestMethod), opts) as Promise<Result>;
            routeResponse = taskResult.routeResponse;
            drainNotification = taskResult.sendNotification;
            validateInbound = taskResult.validateInbound;
        }

        const baseEnv: DispatchEnv = {
            signal: abort.signal,
            sessionId: this.pipe.sessionId,
            authInfo: extra?.authInfo,
            httpReq: extra?.request,
            task,
            send
        };
        const env = this._options.buildEnv ? this._options.buildEnv(extra, baseEnv) : baseEnv;

        const drain = async () => {
            if (validateInbound) {
                try {
                    validateInbound();
                } catch (error) {
                    const e = error as { code?: number; message?: string; data?: unknown };
                    const errResp: JSONRPCErrorResponse = {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: Number.isSafeInteger(e?.code) ? (e.code as number) : -32_603,
                            message: e?.message ?? 'Internal error',
                            ...(e?.data !== undefined && { data: e.data })
                        }
                    };
                    const routed = await routeResponse(errResp);
                    if (!routed) await this.pipe.send(errResp, { relatedRequestId: request.id });
                    return;
                }
            }
            for await (const out of this.dispatcher.dispatch(request, env)) {
                if (out.kind === 'notification') {
                    await drainNotification({ method: out.message.method, params: out.message.params });
                } else {
                    if (abort.signal.aborted) return;
                    const routed = await routeResponse(out.message);
                    if (!routed) await this.pipe.send(out.message, { relatedRequestId: request.id });
                }
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
            if (requestId !== undefined)
                this._requestHandlerAbortControllers.get(requestId)?.abort((notification.params as { reason?: unknown })?.reason);
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
        const taskResult = this._taskManager.processInboundResponse(response, messageId);
        if (taskResult.consumed) return;

        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
            return;
        }
        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        if (!taskResult.preserveProgress) {
            this._progressHandlers.delete(messageId);
        }
        if (isJSONRPCResultResponse(response)) {
            handler(response);
        } else {
            handler(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
        }
    }

    private _onclose(): void {
        this._closed = true;
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = new Map();
        this._progressHandlers.clear();
        this._taskManager.onClose();
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
