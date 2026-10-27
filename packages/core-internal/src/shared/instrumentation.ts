import { SdkError, SdkErrorCode } from '../errors/sdkErrors';
import type { RequestId, Result } from '../types/index';
import { BAGGAGE_META_KEY, ProtocolError, TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '../types/index';

/**
 * Observes the requests and notifications a {@linkcode Protocol} instance sends
 * and receives, for tracing and metrics. Pass it as
 * {@linkcode ProtocolOptions.instrumentation}.
 *
 * The SDK calls `send` or `receive` once per JSON-RPC request or notification
 * (never for responses) and calls `end` on the returned scope exactly once when
 * that message settles. An instrumentation that throws never fails the
 * operation: the error goes to `onerror` and the operation carries on.
 *
 * @experimental The shape may change in a minor release.
 */
export interface ProtocolInstrumentation {
    /** A request or notification is about to be sent. Trace-context keys written to `operation.carrier` go into `params._meta`. */
    send?(operation: OutboundOperation): OperationScope | undefined;
    /** A request or notification arrived and is about to be handled. */
    receive?(operation: InboundOperation): OperationScope | undefined;
}

/**
 * Fields shared by {@linkcode OutboundOperation} and {@linkcode InboundOperation}.
 *
 * @experimental
 */
export interface OperationBase {
    readonly method: string;
    /** The JSON-RPC request id; absent for notifications. */
    readonly id?: RequestId;
    /** The params as they go on, or came off, the wire. Do not mutate. */
    readonly params?: Readonly<Record<string, unknown>>;
    /** The transport's session id, when it has one. */
    readonly sessionId?: string;
    /** The negotiated protocol version, once there is one. */
    readonly protocolVersion?: string;
}

/**
 * A request or notification this instance is sending.
 *
 * @experimental
 */
export interface OutboundOperation extends OperationBase {
    /**
     * Keys written here are copied into the outgoing `params._meta`. Prefilled
     * with any `traceparent`, `tracestate` and `baggage` the caller already set.
     */
    readonly carrier: Record<string, string>;
}

/**
 * A request or notification this instance received.
 *
 * @experimental
 */
export interface InboundOperation extends OperationBase {
    /** The message's `params._meta`, including `traceparent`, `tracestate` and `baggage` when present. */
    readonly meta?: Readonly<Record<string, unknown>>;
    /** Whether a handler (or fallback handler) is registered for `method`. */
    readonly handled: boolean;
    /** The HTTP request the message arrived in, when the transport supplied one. */
    readonly httpRequest?: Request;
}

/**
 * The lifetime of one observed operation.
 *
 * @experimental
 */
export interface OperationScope {
    /** Runs the operation's work (the transport send, or the handler) in the instrumentation's context. Must call `fn` once. */
    run<T>(fn: () => T): T;
    /** Called exactly once when the operation settles. */
    end(outcome: OperationOutcome): void;
}

/**
 * How an observed operation settled.
 *
 * - `result`: a request answered with a result, as it went on or came off the wire.
 * - `error`: a request answered with a JSON-RPC error; `cause` is what the local handler threw, if anything.
 * - `delivered`: a notification was written to the transport, or its handler returned.
 * - `timeout`: the request timed out locally.
 * - `cancelled`: the request was cancelled, by the caller's signal or by the peer.
 * - `closed`: the connection closed before the operation settled.
 * - `failed`: any other local failure, such as a failed send or a result that fails validation.
 *
 * @experimental
 */
export type OperationOutcome =
    | { type: 'result'; result: Result }
    | { type: 'error'; error: { code: number; message: string }; cause?: unknown }
    | { type: 'delivered' }
    | { type: 'timeout' }
    | { type: 'cancelled' }
    | { type: 'closed' }
    | { type: 'failed'; error: unknown };

/** An {@linkcode OperationScope} whose methods never throw and whose `end` runs at most once. */
export interface GuardedScope {
    run<T>(fn: () => T): T;
    end(outcome: OperationOutcome): void;
}

const TRACE_CONTEXT_META_KEYS = [TRACEPARENT_META_KEY, TRACESTATE_META_KEY, BAGGAGE_META_KEY] as const;

/** A carrier prefilled with the string trace-context keys found in `meta`. */
export function traceContextCarrier(meta: unknown): Record<string, string> {
    const carrier: Record<string, string> = {};
    if (meta === null || typeof meta !== 'object') return carrier;
    for (const key of TRACE_CONTEXT_META_KEYS) {
        const value = (meta as Record<string, unknown>)[key];
        if (typeof value === 'string') carrier[key] = value;
    }
    return carrier;
}

/** Calls `start` and guards the scope it returns; `report` receives anything the instrumentation throws. */
export function startScope(start: () => OperationScope | undefined, report: (error: Error) => void): GuardedScope | undefined {
    let scope: OperationScope | undefined;
    try {
        scope = start();
    } catch (error) {
        report(asInstrumentationError(error));
        return undefined;
    }
    return scope === undefined ? undefined : guardScope(scope, report);
}

/** Runs `fn` in `scope` when there is one. */
export function runInScope<T>(scope: GuardedScope | undefined, fn: () => T): T {
    return scope === undefined ? fn() : scope.run(fn);
}

/** The outcome for an error that settled an outbound request. */
export function outcomeForError(error: unknown): OperationOutcome {
    if (error instanceof ProtocolError) return { type: 'error', error: { code: error.code, message: error.message }, cause: error };
    if (error instanceof SdkError) {
        if (error.code === SdkErrorCode.ConnectionClosed) return { type: 'closed' };
        if (error.code === SdkErrorCode.RequestTimeout) return { type: 'timeout' };
    }
    return { type: 'failed', error };
}

/** The outcome for an inbound request whose handler was aborted. */
export function outcomeForAbort(reason: unknown): OperationOutcome {
    return reason instanceof SdkError && reason.code === SdkErrorCode.ConnectionClosed ? { type: 'closed' } : { type: 'cancelled' };
}

function guardScope(scope: OperationScope, report: (error: Error) => void): GuardedScope {
    let settled = false;
    return {
        run<T>(fn: () => T): T {
            let state = 'pending' as 'pending' | 'ok' | 'threw';
            let value: T | undefined;
            let thrown: unknown;
            let runError: unknown;
            try {
                scope.run(() => {
                    try {
                        value = fn();
                        state = 'ok';
                        return value;
                    } catch (error) {
                        state = 'threw';
                        thrown = error;
                        throw error;
                    }
                });
            } catch (error) {
                if (state !== 'threw') runError = error;
            }
            if (runError !== undefined) report(asInstrumentationError(runError));
            if (state === 'ok') return value as T;
            if (state === 'threw') throw thrown;
            if (runError === undefined) report(new Error('Instrumentation failed: scope.run() did not call fn'));
            return fn();
        },
        end(outcome: OperationOutcome): void {
            if (settled) return;
            settled = true;
            try {
                scope.end(outcome);
            } catch (error) {
                report(asInstrumentationError(error));
            }
        }
    };
}

function asInstrumentationError(error: unknown): Error {
    return new Error(`Instrumentation failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
