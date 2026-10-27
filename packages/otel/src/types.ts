/*
 * Structural copies of the experimental instrumentation types that
 * `@modelcontextprotocol/client` and `@modelcontextprotocol/server` export, so this
 * package needs neither of them at runtime. `test/types.test.ts` checks they stay
 * assignable to the SDK's own types.
 */

/** A JSON-RPC request id. */
export type RequestId = string | number;

/** Fields shared by {@linkcode OutboundOperation} and {@linkcode InboundOperation}. */
export interface OperationBase {
    readonly method: string;
    readonly id?: RequestId;
    readonly params?: Readonly<Record<string, unknown>>;
    readonly sessionId?: string;
    readonly protocolVersion?: string;
}

/** A request or notification the instrumented instance is sending. */
export interface OutboundOperation extends OperationBase {
    readonly carrier: Record<string, string>;
}

/** A request or notification the instrumented instance received. */
export interface InboundOperation extends OperationBase {
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly handled: boolean;
    readonly httpRequest?: Request;
}

/** How an observed operation settled. */
export type OperationOutcome =
    | { type: 'result'; result: Readonly<Record<string, unknown>> }
    | { type: 'error'; error: { code: number; message: string }; cause?: unknown }
    | { type: 'delivered' }
    | { type: 'timeout' }
    | { type: 'cancelled' }
    | { type: 'closed' }
    | { type: 'failed'; error: unknown };

/** The lifetime of one observed operation. */
export interface OperationScope {
    run<T>(fn: () => T): T;
    end(outcome: OperationOutcome): void;
}

/** The value `openTelemetry()` returns: pass it as the `instrumentation` option. */
export interface ProtocolInstrumentation {
    send?(operation: OutboundOperation): OperationScope | undefined;
    receive?(operation: InboundOperation): OperationScope | undefined;
}
