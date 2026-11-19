import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import { HEADER_MISMATCH_ERROR_CODE, ProtocolError } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

import { NoCompatibleDeliveryModeError } from './errors';
import type { EventsConnection } from './request';
import type { DriverContext, SubscribeOptions } from './subscription';

// setTimeout fires at once beyond this.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

// An error of the first exchange that subscribe() rejects with (a -32020 only once its re-list is spent); any other (transport, non-Events JSON-RPC, a verification limit) is retried in the background.
export function refusesSubscription(error: unknown): boolean {
    return (error instanceof EventsError && !isVerificationLimit(error)) || error instanceof SdkError || isHeaderMismatch(error);
}

// The server's webhook verification limit per destination host: the one `resourceExhausted` that passes with time, so it is retried.
export function isVerificationLimit(error: unknown): boolean {
    return (
        error instanceof EventsError &&
        error.kind === 'resourceExhausted' &&
        (error.data as { limit?: unknown } | undefined)?.limit === 'verification'
    );
}

// How long a verification limit asks to wait before the next attempt: its `data.retryAfterMs`, when a non-negative number.
export function retryAfterOf(error: unknown): number | undefined {
    if (!isVerificationLimit(error)) return undefined;
    const retryAfterMs = ((error as EventsError).data as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retryAfterMs === 'number' && retryAfterMs >= 0 ? retryAfterMs : undefined;
}

// A -32020: the request's `Mcp-Param` headers do not match its arguments (D26).
export function isHeaderMismatch(error: unknown): boolean {
    return error instanceof ProtocolError && error.code === HEADER_MISMATCH_ERROR_CODE;
}

// What a subscription ends with when its client's connection closes.
export function closedError(cause?: unknown): SdkError {
    return new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed', undefined, cause === undefined ? undefined : { cause });
}

// The SdkError a subscription ends with when its client's connection is gone, judged at a failed request; `undefined` while connected.
export function connectionClosed(connection: EventsConnection, error: unknown): SdkError | undefined {
    if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) return error;
    const notConnected = error instanceof SdkError && error.code === SdkErrorCode.NotConnected;
    if (!notConnected && connection.client.transport !== undefined) return undefined;
    return closedError(error);
}

// An `unsupported` error saying the event type's schema changed in place.
export function isSchemaChange(error: unknown): boolean {
    return (
        error instanceof EventsError &&
        error.kind === 'unsupported' &&
        (error.data as { reason?: unknown } | undefined)?.reason === 'schema_changed'
    );
}

// Every mode's recovery once subscribed (spec §6.3): `relist` and go on while still offered, `mismatch` (re-list and retry once, then end), `fail` (end with the error), or `retry` later (anything but an Events kind, and a verification limit).
export function recoveryFor(error: unknown): 'relist' | 'mismatch' | 'fail' | 'retry' {
    if (isHeaderMismatch(error)) return 'mismatch';
    if (!(error instanceof EventsError) || isVerificationLimit(error)) return 'retry';
    return error.kind === 'notFound' || isSchemaChange(error) ? 'relist' : 'fail';
}

// Reports a possible gap at `cursor` through onGap; a throwing onGap goes to the client's onerror, and delivery goes on.
export function reportGap(subscription: SubscribeOptions, connection: EventsConnection, cursor: string | null): void {
    try {
        subscription.onGap?.(cursor);
    } catch (error) {
        connection.report(error);
    }
}

// Re-lists, then throws why `name` cannot be subscribed with `mode`: notFound when unlisted, NoCompatibleDeliveryModeError when `mode` is not offered.
export async function requireOffered(connection: EventsConnection, name: string, mode: DeliveryMode, signal: AbortSignal): Promise<void> {
    try {
        await connection.list(undefined, { signal });
    } catch (error) {
        throw connectionClosed(connection, error) ?? error;
    }
    const descriptor = connection.descriptor(name);
    if (descriptor === undefined) throw new EventsError('notFound', 'Event type not found', { kind: 'event' });
    if (!descriptor.delivery.includes(mode)) throw new NoCompatibleDeliveryModeError(name, descriptor.delivery, [mode]);
}

// Re-lists, then whether `name` is still listed with `mode`; `undefined` when the list fails.
export async function stillOffered(
    connection: EventsConnection,
    name: string,
    mode: DeliveryMode,
    signal: AbortSignal
): Promise<boolean | undefined> {
    try {
        await connection.list(undefined, { signal });
    } catch {
        return undefined;
    }
    return connection.descriptor(name)?.delivery.includes(mode) === true;
}

// random() × min(30 s, 1 s × 2^attempt) (SEP: jitter before reconnecting).
export function jitteredDelay(attempt: number): number {
    return Math.random() * Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
}

// A mode's own steps: `interrupt` ends what its loop waits on besides sleep(), on stop() and on a close; `closed` runs on a close.
export interface LoopHooks {
    interrupt?: () => void;
    closed?: () => void;
}

// The loop every mode's driver runs (spec §6.3): its cursor and the reset to now, the first exchange that settles start(), waits that stop() or a closed connection end at once, and the recovery rules.
export class DriverLoop<T> {
    readonly #context: DriverContext<T>;
    readonly #mode: DeliveryMode;
    // Aborts requests in flight on stop().
    readonly #abort = new AbortController();
    #cursor: string | null;
    // Sent until an exchange succeeds.
    #maxAgeMs: number | undefined;
    // Until an exchange succeeds, or the first one fails transiently.
    #first = true;
    // A schema change has refused the subscription since the last successful exchange.
    #schemaChanged = false;
    // The cursor was reset to now; the next successful exchange reports the gap.
    #reset = false;
    #stopped = false;
    // Set by the connection's close listener, which ends the subscription at once.
    #closed = false;
    #settle: { resolve(): void; reject(error: unknown): void } = { resolve: () => {}, reject: () => {} };
    #hooks: LoopHooks = {};
    #wake: (() => void) | undefined;
    #running: Promise<void> = Promise.resolve();

    constructor(context: DriverContext<T>, mode: DeliveryMode) {
        this.#context = context;
        this.#mode = mode;
        this.#cursor = context.subscription.cursor ?? null;
        this.#maxAgeMs = context.subscription.maxAgeMs;
    }

    get cursor(): string | null {
        return this.#cursor;
    }

    get maxAgeMs(): number | undefined {
        return this.#maxAgeMs;
    }

    // start() has not settled: the first exchange has neither succeeded nor failed transiently.
    get first(): boolean {
        return this.#first;
    }

    get signal(): AbortSignal {
        return this.#abort.signal;
    }

    // stop() was called or the connection closed: the loop returns.
    get ended(): boolean {
        return this.#stopped || this.#closed;
    }

    // Runs `run` until it returns, or throws the error that ends the subscription; settles as the first exchange does.
    start(run: () => Promise<void>, hooks: LoopHooks = {}): Promise<void> {
        const first = new Promise<void>((resolve, reject) => (this.#settle = { resolve, reject }));
        this.#hooks = hooks;
        const removeCloseListener = this.#context.connection.onClose(() => {
            this.#closed = true;
            this.#interrupt();
            hooks.closed?.();
            this.#fail(closedError());
        });
        this.#running = run()
            .then(
                () => this.#settle.resolve(),
                (error: unknown) => this.#fail(error)
            )
            .finally(removeCloseListener);
        return first;
    }

    // Aborts requests in flight, ends the current wait, runs `cleanup`, and resolves once the loop has returned.
    async stop(cleanup?: () => Promise<void>): Promise<void> {
        this.#stopped = true;
        this.#abort.abort();
        this.#interrupt();
        await cleanup?.();
        await this.#running;
    }

    // The first exchange succeeded or failed transiently: start() resolves.
    subscribed(): void {
        this.#first = false;
        this.#settle.resolve();
    }

    // An exchange succeeded at `cursor`: `maxAgeMs` is no longer sent, and a gap is reported on `truncated` or after a reset to now.
    succeeded(cursor: string | null, truncated: boolean): void {
        const reset = this.#reset;
        this.#maxAgeMs = undefined;
        this.#schemaChanged = false;
        this.#reset = false;
        // A type without replay has no position to have skipped past (SEP: ignore `truncated`).
        if (reset || (truncated && cursor !== null)) reportGap(this.#context.subscription, this.#context.connection, cursor);
    }

    setCursor(cursor: string | null): void {
        this.#cursor = cursor;
        this.#context.queue.setCursor(cursor);
    }

    // Resolves after `ms`, or at once on wake(), stop() or a close.
    sleep(ms: number): Promise<void> {
        return new Promise(resolve => {
            if (this.ended) return resolve();
            const wake = (): void => {
                clearTimeout(timer);
                this.#wake = undefined;
                resolve();
            };
            const timer = setTimeout(wake, Math.min(ms, MAX_TIMER_DELAY_MS));
            this.#wake = wake;
        });
    }

    wake(): void {
        this.#wake?.();
    }

    // After an exchange failed with `error` (spec §6.3): throws when that ends the subscription; `restarted` when the first exchange's stale cursor was dropped for now.
    async recover(error: unknown): Promise<'restarted' | 'retry'> {
        const { connection, subscription } = this.#context;
        const closed = connectionClosed(connection, error);
        if (closed !== undefined) throw closed;
        if (this.#first) {
            // A stale cursor passed to subscribe(): drop it and start from now, if the event type still offers this mode.
            if (isSchemaChange(error) && this.#cursor !== null) {
                try {
                    await requireOffered(connection, subscription.name, this.#mode, this.#abort.signal);
                } catch (listError) {
                    if (refusesSubscription(listError)) throw listError;
                    // A transient re-list failure is retried in the background, from now, as a transient first exchange is.
                    this.#restartFromNow();
                    this.subscribed();
                    return 'retry';
                }
                this.#restartFromNow();
                return 'restarted';
            }
            if (refusesSubscription(error)) throw error;
            this.subscribed();
            return 'retry';
        }
        const recovery = recoveryFor(error);
        if (recovery === 'retry') return 'retry';
        // A -32020 here is the second: the mode has already re-listed once and retried with fresh headers.
        if (recovery !== 'relist') throw error;
        const offered = await stillOffered(connection, subscription.name, this.#mode, this.#abort.signal);
        if (offered === false) throw error;
        if (isSchemaChange(error)) this.#schemaChange();
        return 'retry';
    }

    #restartFromNow(): void {
        this.#cursor = null;
        this.#reset = true;
    }

    // A second schema change in a row means the last cursor is refused (SEP: a stale schema epoch), so start again from now.
    #schemaChange(): void {
        if (this.#schemaChanged && this.#cursor !== null) this.#restartFromNow();
        this.#schemaChanged = true;
    }

    #interrupt(): void {
        this.#wake?.();
        this.#hooks.interrupt?.();
    }

    #fail(error: unknown): void {
        this.#settle.reject(error);
        this.#context.queue.fail(error);
    }
}
