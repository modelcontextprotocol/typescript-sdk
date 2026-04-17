import type {
    Dispatcher,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Notification,
    Progress,
    Request,
    RequestOptions,
    Transport
} from '@modelcontextprotocol/core';
import { getResultSchema, StreamDriver } from '@modelcontextprotocol/core';

/**
 * Per-call options for {@linkcode ClientTransport.fetch}.
 */
export type ClientFetchOptions = {
    /** Abort the in-flight request. */
    signal?: AbortSignal;
    /** Called for each `notifications/progress` received before the terminal response. */
    onprogress?: (progress: Progress) => void;
    /** Called for each non-progress notification received before the terminal response. */
    onnotification?: (notification: JSONRPCNotification) => void;
    /** Per-request timeout (ms). */
    timeout?: number;
    /** Reset {@linkcode timeout} when a progress notification arrives. */
    resetTimeoutOnProgress?: boolean;
    /** Absolute upper bound (ms) regardless of progress. */
    maxTotalTimeout?: number;
};

/**
 * Request-shaped client transport. One JSON-RPC request in, one terminal
 * response out. The transport may be stateful internally (session id, protocol
 * version) but the contract is per-call.
 *
 * This is the 2026-06-native shape. The legacy pipe {@linkcode Transport}
 * interface is adapted via {@linkcode pipeAsClientTransport}.
 */
export interface ClientTransport {
    /**
     * Send one JSON-RPC request and resolve with the terminal response.
     * Any progress/notifications received before the response are surfaced
     * via the callbacks in {@linkcode ClientFetchOptions}.
     */
    fetch(request: JSONRPCRequest, opts?: ClientFetchOptions): Promise<JSONRPCResultResponse | JSONRPCErrorResponse>;

    /**
     * Send a fire-and-forget notification.
     */
    notify(notification: Notification): Promise<void>;

    /**
     * Open a server→client subscription stream for list-changed and other
     * unsolicited notifications. Optional; transports that cannot stream
     * (e.g. plain HTTP without SSE GET) omit this.
     */
    subscribe?(filter?: string[]): AsyncIterable<JSONRPCNotification>;

    /**
     * Close the transport and release resources.
     */
    close(): Promise<void>;

    /** The underlying {@linkcode StreamDriver} when adapted from a pipe. Compat-only. */
    readonly driver?: StreamDriver;
}

/**
 * Type guard distinguishing the legacy pipe-shaped {@linkcode Transport} from
 * a request-shaped {@linkcode ClientTransport}.
 */
export function isPipeTransport(t: Transport | ClientTransport): t is Transport {
    return typeof (t as Transport).start === 'function' && typeof (t as Transport).send === 'function';
}

/**
 * Adapt a legacy pipe-shaped {@linkcode Transport} (stdio, SSE, InMemory, the
 * v1 SHTTP client transport) into a {@linkcode ClientTransport}.
 *
 * Correlation, timeouts, progress and cancellation are handled by an internal
 * {@linkcode StreamDriver}. The supplied {@linkcode Dispatcher} services any
 * server-initiated requests (sampling, elicitation, roots) that arrive on the pipe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapter is context-agnostic; the caller's Dispatcher subclass owns ContextT
export function pipeAsClientTransport(pipe: Transport, dispatcher: Dispatcher<any>): ClientTransport {
    const driver = new StreamDriver(dispatcher, pipe);
    let started = false;
    const subscribers: Set<(n: JSONRPCNotification) => void> = new Set();
    dispatcher.fallbackNotificationHandler = async n => {
        const msg: JSONRPCNotification = { jsonrpc: '2.0', method: n.method, params: n.params };
        for (const s of subscribers) s(msg);
    };
    const ensureStarted = async () => {
        if (!started) {
            started = true;
            await driver.start();
        }
    };
    return {
        driver,
        async fetch(request, opts) {
            await ensureStarted();
            const schema = getResultSchema(request.method as never);
            try {
                const result = await driver.request({ method: request.method, params: request.params } as Request, schema, {
                    signal: opts?.signal,
                    timeout: opts?.timeout,
                    resetTimeoutOnProgress: opts?.resetTimeoutOnProgress,
                    maxTotalTimeout: opts?.maxTotalTimeout,
                    onprogress: opts?.onprogress
                } as RequestOptions);
                return { jsonrpc: '2.0', id: request.id, result } as JSONRPCResultResponse;
            } catch (error) {
                const e = error as { code?: number; message?: string; data?: unknown };
                if (typeof e?.code === 'number') {
                    return { jsonrpc: '2.0', id: request.id, error: { code: e.code, message: e.message ?? 'Error', data: e.data } };
                }
                throw error;
            }
        },
        async notify(notification) {
            await ensureStarted();
            await driver.notification(notification);
        },
        async *subscribe() {
            await ensureStarted();
            const queue: JSONRPCNotification[] = [];
            let wake: (() => void) | undefined;
            const push = (n: JSONRPCNotification) => {
                queue.push(n);
                wake?.();
            };
            subscribers.add(push);
            try {
                while (true) {
                    while (queue.length > 0) yield queue.shift()!;
                    await new Promise<void>(r => (wake = r));
                    wake = undefined;
                }
            } finally {
                subscribers.delete(push);
            }
        },
        async close() {
            await driver.close();
        }
    };
}

/** Re-exported so callers can detect protocol-level errors uniformly. */

export { isJSONRPCErrorResponse } from '@modelcontextprotocol/core';
