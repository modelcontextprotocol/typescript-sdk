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
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { validateStandardSchema } from '../util/standardSchema.js';
import type { Outbound, RequestEnv } from './context.js';
import type { Dispatcher } from './dispatcher.js';
import type { NotificationOptions, ProgressCallback, RequestOptions } from './protocol.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from './protocol.js';
import type { Transport } from './transport.js';

/**
 * Pass-through Standard Schema. Used where a schema-typed call needs to deliver the raw
 * `Result` and let the caller (e.g. {@linkcode Dispatcher}'s `mcpReq.send`) apply the
 * user-supplied or spec result schema.
 *
 * @internal
 */
export const RAW_RESULT_SCHEMA: StandardSchemaV1<unknown, Result> = {
    '~standard': { version: 1, vendor: 'mcp-passthrough', validate: value => ({ value: value as Result }) }
};

type TimeoutInfo = {
    timeoutId: ReturnType<typeof setTimeout>;
    startTime: number;
    timeout: number;
    maxTotalTimeout?: number;
    resetTimeoutOnProgress: boolean;
    onTimeout: () => void;
};

/** @internal */
export type StreamDriverOptions = {
    supportedProtocolVersions?: string[];
    debouncedNotificationMethods?: string[];
    /**
     * Hook to enrich the per-request {@linkcode RequestEnv} from transport-supplied
     * {@linkcode MessageExtraInfo} (e.g. auth, http req).
     */
    buildEnv?: (extra: MessageExtraInfo | undefined, base: RequestEnv) => RequestEnv;
};

/**
 * Options for {@linkcode attachChannelTransport}. Mirrors {@linkcode StreamDriverOptions}
 * plus the `onclose`/`onerror`/`onresponse` callbacks the caller would otherwise set
 * on the driver instance.
 *
 * @internal
 */
export type AttachOptions = StreamDriverOptions & {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onresponse?: (
        response: JSONRPCResultResponse | JSONRPCErrorResponse,
        messageId: number
    ) => { consumed: boolean; preserveProgress?: boolean };
};

/**
 * Runs a {@linkcode Dispatcher} over a persistent bidirectional {@linkcode Transport}
 * (stdio, WebSocket, InMemory). Owns all per-connection state: outbound request
 * id correlation, timeouts, progress callbacks, cancellation, debouncing.
 *
 * One driver per pipe. The dispatcher it wraps may be shared.
 *
 * @internal
 */
export class StreamDriver implements Outbound {
    private _requestMessageId = 0;
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();
    private _closed = false;
    private _supportedProtocolVersions: string[];

    onclose?: () => void;
    onerror?: (error: Error) => void;
    /**
     * Tap for every inbound response. Return `consumed: true` to claim it (suppresses the
     * matched-handler dispatch / unknown-id error). Return `preserveProgress: true` to keep
     * the progress handler registered after the matched handler runs. Set by the owner.
     */
    onresponse?: (response: JSONRPCResponse | JSONRPCErrorResponse, messageId: number) => { consumed: boolean; preserveProgress?: boolean };

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver is context-agnostic; owner supplies ContextT via dispatcher
        readonly dispatcher: Dispatcher<any>,
        readonly pipe: Transport,
        private _options: StreamDriverOptions = {}
    ) {
        this._supportedProtocolVersions = _options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    }

    /** Exposed so an owner can clear progress callbacks. See {@linkcode Outbound.removeProgressHandler}. */
    removeProgressHandler(token: number): void {
        this._progressHandlers.delete(token);
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

    /** {@linkcode Outbound.setProtocolVersion} — delegates to the pipe. */
    setProtocolVersion(version: string): void {
        this.pipe.setProtocolVersion?.(version);
    }

    /** {@linkcode Outbound.sendRaw} — write a raw JSON-RPC message to the pipe. */
    async sendRaw(message: Parameters<Transport['send']>[0], options?: { relatedRequestId?: RequestId }): Promise<void> {
        await this.pipe.send(message, options);
    }

    /**
     * Sends a request over the pipe and resolves with the parsed result.
     */
    request<T extends StandardSchemaV1>(req: Request, resultSchema: T, options?: RequestOptions): Promise<StandardSchemaV1.InferOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken } = options ?? {};
        let onAbort: (() => void) | undefined;
        let cleanupId: number | undefined;

        let responseReceived = false;

        return new Promise<StandardSchemaV1.InferOutput<T>>((resolve, reject) => {
            if (options?.signal?.aborted) {
                throw options.signal.reason;
            }

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
                if (responseReceived) return;
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
                responseReceived = true;
                if (options?.signal?.aborted) return;
                if (response instanceof Error) return reject(response);
                validateStandardSchema(resultSchema, response.result).then(
                    parsed =>
                        parsed.success
                            ? resolve(parsed.data)
                            : reject(new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${req.method}: ${parsed.error}`)),
                    reject
                );
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
        if (this._closed) return;
        const jsonrpc: JSONRPCNotification = { jsonrpc: '2.0', method: notification.method, params: notification.params };

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

        const baseEnv: RequestEnv = {
            signal: abort.signal,
            authInfo: extra?.authInfo,
            httpReq: extra?.request,
            sessionId: this.pipe.sessionId,
            send: (r, opts) => this.request(r, RAW_RESULT_SCHEMA, { ...opts, relatedRequestId: request.id }) as Promise<Result>
        };
        const env = this._options.buildEnv ? this._options.buildEnv(extra, baseEnv) : baseEnv;

        const drain = async () => {
            for await (const out of this.dispatcher.dispatch(request, env)) {
                if (out.kind === 'notification') {
                    await this.pipe.send(out.message, { relatedRequestId: request.id });
                } else if (!abort.signal.aborted) {
                    await this.pipe.send(out.message, { relatedRequestId: request.id });
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
            this._onprogress(notification.params as ProgressNotification['params']);
            return;
        }
        this.dispatcher
            .dispatchNotification(notification)
            .catch(error => this._onerror(new Error(`Uncaught error in notification handler: ${error}`)));
    }

    private _onprogress(progressParams: ProgressNotification['params']): void {
        const { progressToken, ...params } = progressParams;
        const messageId = Number(progressToken);
        const handler = this._progressHandlers.get(messageId);
        if (!handler) {
            this._onerror(new Error(`Received a progress notification for an unknown token: ${JSON.stringify(progressParams)}`));
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
        const tap = this.onresponse?.(response, messageId);
        if (tap?.consumed) return;
        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
            return;
        }
        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        if (!tap?.preserveProgress) this._progressHandlers.delete(messageId);
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

/**
 * Wraps a {@linkcode Transport} in a {@linkcode StreamDriver} and starts it.
 *
 * @internal
 */
export async function attachChannelTransport(
    pipe: Transport,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter is context-agnostic
    dispatcher: Dispatcher<any>,
    options?: AttachOptions
): Promise<Outbound> {
    const driver = new StreamDriver(dispatcher, pipe, options);
    if (options?.onclose || options?.onerror || options?.onresponse) {
        driver.onclose = options.onclose;
        driver.onerror = options.onerror;
        driver.onresponse = options.onresponse;
    }
    await driver.start();
    return driver;
}
