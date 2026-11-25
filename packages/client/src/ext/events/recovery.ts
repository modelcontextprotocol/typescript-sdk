import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import { HEADER_MISMATCH_ERROR_CODE, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';
import { OAuthError, OAuthErrorCode, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/core-internal/public';

import { UnauthorizedError } from '../../client/auth';
import { OAuthClientFlowError } from '../../client/authErrors';
import { isAuthSeamEscape } from '../../client/authSeam';
import { NoCompatibleDeliveryModeError } from './errors';
import type { EventsConnection } from './request';
import type { DriverContext, SubscribeOptions } from './subscription';

// setTimeout fires at once beyond this.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
// Retried failures are reported at once, then counted and reported together at most this often per subscription.
const RETRY_REPORT_INTERVAL_MS = 60_000;
// JSON-RPC codes that end a subscription: the server no longer serves the method, or rejects its params.
const FINAL_CODES: ReadonlySet<number> = new Set([ProtocolErrorCode.MethodNotFound, ProtocolErrorCode.InvalidParams]);

// OAuth error codes of a token source that passes with time.
const TRANSIENT_OAUTH_CODES: ReadonlySet<string> = new Set([
    OAuthErrorCode.ServerError,
    OAuthErrorCode.TemporarilyUnavailable,
    OAuthErrorCode.TooManyRequests
]);

// An auth failure only the user or the configuration can fix (a retry would run auth() again for nothing); any other, such as a network failure of the token source, passes with time.
function isFinalAuthFailure(error: unknown): boolean {
    if (error instanceof UnauthorizedError || error instanceof SdkError || error instanceof OAuthClientFlowError) return true;
    return error instanceof OAuthError && !TRANSIENT_OAUTH_CODES.has(error.code);
}

// An error that ends a live subscription: a final auth failure of the transport, a -32601 or a -32602; any other auth failure is retried like a transport failure.
export function endsSubscription(error: unknown): boolean {
    return (isAuthSeamEscape(error) && isFinalAuthFailure(error)) || (error instanceof ProtocolError && FINAL_CODES.has(error.code));
}

// An error of the first exchange that subscribe() rejects with: any auth failure of the transport, so a misconfigured provider rejects, and a -32020 only once its re-list is spent; any other (transport, an HTTP 5xx or 429, another non-Events JSON-RPC error, a verification limit) is retried in the background.
export function refusesSubscription(error: unknown): boolean {
    if (isAuthSeamEscape(error) || endsSubscription(error)) return true;
    if (error instanceof SdkHttpError) return !(error.status >= 500 || error.status === 429);
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

// An `unsupported` error saying the server does not offer the delivery mode used.
export function isModeRefusal(error: unknown): boolean {
    return (
        error instanceof EventsError &&
        error.kind === 'unsupported' &&
        (error.data as { feature?: unknown } | undefined)?.feature === 'deliveryMode'
    );
}

// Every mode's recovery once subscribed (spec §6.3): `relist` and go on while still offered, `mismatch` (re-list and retry once, then end), `fail` (end with the error), or `retry` later (anything but an Events kind or an endsSubscription() error, such as a transport or non-final auth failure, and a verification limit).
export function recoveryFor(error: unknown): 'relist' | 'mismatch' | 'fail' | 'retry' {
    if (endsSubscription(error)) return 'fail';
    if (isHeaderMismatch(error)) return 'mismatch';
    if (!(error instanceof EventsError) || isVerificationLimit(error)) return 'retry';
    return error.kind === 'notFound' || isSchemaChange(error) ? 'relist' : 'fail';
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Reports a possible gap at `cursor` through onGap; a throwing onGap goes to the client's onerror, and delivery goes on.
export function reportGap(subscription: SubscribeOptions, connection: EventsConnection, cursor: string | null): void {
    try {
        subscription.onGap?.(cursor);
    } catch (error) {
        connection.report(error);
    }
}

// The floor subscribe() fixes when it is given a cursor and `maxAgeMs`; the spec ignores `maxAgeMs` with a null cursor, so a subscription that starts from now has none.
export function floorOf({ cursor, maxAgeMs }: SubscribeOptions): number | undefined {
    return cursor === undefined || cursor === null || maxAgeMs === undefined ? undefined : Date.now() - maxAgeMs;
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

// Re-lists, then whether `name` is still listed with `mode`; `undefined` when the list fails, unless with an endsSubscription() error, which it throws.
export async function stillOffered(
    connection: EventsConnection,
    name: string,
    mode: DeliveryMode,
    signal: AbortSignal
): Promise<boolean | undefined> {
    try {
        await connection.list(undefined, { signal });
    } catch (error) {
        if (endsSubscription(error)) throw error;
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
    // The subscription's floor (DriverContext.floor), before which no event is delivered for its life.
    readonly #floor: number | undefined;
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
    // Retried failures since the last report and the latest of them, when that report went out, and the timer of the next.
    #retried = 0;
    #lastRetried: unknown;
    #reportedAt: number | undefined;
    #report: ReturnType<typeof setTimeout> | undefined;

    constructor(context: DriverContext<T>, mode: DeliveryMode) {
        this.#context = context;
        this.#mode = mode;
        this.#cursor = context.subscription.cursor ?? null;
        this.#floor = context.floor;
    }

    get cursor(): string | null {
        return this.#cursor;
    }

    // The `maxAgeMs` every request of the subscription sends: the time since the floor.
    get maxAgeMs(): number | undefined {
        return this.#floor === undefined ? undefined : Math.max(0, Date.now() - this.#floor);
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
        clearTimeout(this.#report);
        await cleanup?.();
        await this.#running;
    }

    // The first exchange succeeded or failed transiently: start() resolves.
    subscribed(): void {
        this.#first = false;
        this.#settle.resolve();
    }

    // An exchange succeeded at `cursor`: a gap is reported on `truncated` or after a reset to now.
    succeeded(cursor: string | null, truncated: boolean): void {
        const reset = this.#reset;
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
                    this.#retrying(listError);
                    return 'retry';
                }
                this.#restartFromNow();
                return 'restarted';
            }
            if (refusesSubscription(error)) throw error;
            this.subscribed();
            this.#retrying(error);
            return 'retry';
        }
        const recovery = recoveryFor(error);
        if (recovery === 'retry') {
            this.#retrying(error);
            return 'retry';
        }
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

    // Reports a failure the loop retries to onerror at once, unless a report went out in the last RETRY_REPORT_INTERVAL_MS; then it counts towards the next.
    #retrying(error: unknown): void {
        if (this.ended) return;
        const now = Date.now();
        if (this.#report === undefined && (this.#reportedAt === undefined || now - this.#reportedAt >= RETRY_REPORT_INTERVAL_MS)) {
            this.#reportedAt = now;
            this.#context.connection.report(new Error(`${this.#subject()} failed and is retried: ${messageOf(error)}`, { cause: error }));
            return;
        }
        this.#retried += 1;
        this.#lastRetried = error;
        this.#report ??= setTimeout(() => this.#reportRetried(), this.#reportedAt! + RETRY_REPORT_INTERVAL_MS - now);
    }

    // Reports how many failures were retried since the last report, and the latest.
    #reportRetried(): void {
        const retried = this.#retried;
        const latest = this.#lastRetried;
        this.#report = undefined;
        this.#reportedAt = Date.now();
        this.#retried = 0;
        this.#lastRetried = undefined;
        const failures = retried === 1 ? 'failure' : 'failures';
        this.#context.connection.report(
            new Error(`${this.#subject()}: ${retried} more retried ${failures} since the last report, the latest: ${messageOf(latest)}`, {
                cause: latest
            })
        );
    }

    #subject(): string {
        return `${this.#mode} subscription to '${this.#context.subscription.name}'`;
    }

    #interrupt(): void {
        this.#wake?.();
        this.#hooks.interrupt?.();
    }

    #fail(error: unknown): void {
        clearTimeout(this.#report);
        this.#settle.reject(error);
        this.#context.queue.fail(error);
    }
}
