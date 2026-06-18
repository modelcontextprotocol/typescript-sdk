/**
 * The multi-round-trip auto-fulfilment driver (protocol revision 2026-07-28).
 *
 * When a request to one of the multi-round-trip methods comes back as
 * `input_required`, the driver fulfils the embedded input requests by
 * dispatching them to the client's already-registered handlers (elicitation,
 * sampling, roots — one generic engine, no per-feature API), then retries the
 * original request with the collected `inputResponses` and a byte-exact echo
 * of `requestState`, on a fresh request id, until the server returns a
 * complete result or the round cap is exhausted.
 *
 * The driver is a LAYER OVER THE MANUAL PATH: each retry is issued with the
 * same primitive a manual caller uses (`allowInputRequired` semantics — the
 * retry hands back the next `input_required` payload instead of recursing),
 * so the loop, the cap, and the pacing live in one place and disabling
 * auto-fulfilment (`inputRequired.autoFulfill: false`) simply skips this
 * module. Timeouts ride the EXISTING knobs: the per-leg `timeout` applies to
 * every wire leg unchanged, and `maxTotalTimeout` bounds the whole flow by
 * shrinking the budget passed to each leg — no new timer system.
 */
import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import { isInputRequiredResult } from '../types/guards.js';
import type { Progress } from '../types/types.js';

/**
 * Whether the multi-round-trip driver fulfils `input_required` results
 * automatically when the consumer has not configured
 * `inputRequired.autoFulfill`. The single switch for the default posture.
 */
export const DEFAULT_INPUT_REQUIRED_AUTO_FULFILL = true;

/**
 * Default round cap for the auto-fulfilment driver (both request legs and
 * requestState-only legs count). Aligned with the other SDK client engines.
 */
export const DEFAULT_INPUT_REQUIRED_MAX_ROUNDS = 10;

/**
 * Fixed pacing applied before retrying a requestState-only (load-shedding)
 * leg — a leg that carries no embedded input requests, so nothing slows the
 * loop down naturally. Counted in the same round cap.
 */
export const REQUEST_STATE_ONLY_LEG_PACING_MS = 250;

/**
 * Multi-round-trip driver options (`inputRequired` on the client options bag).
 */
export interface InputRequiredOptions {
    /**
     * Fulfil `input_required` results automatically by dispatching the
     * embedded requests to the registered handlers and retrying.
     *
     * Set to `false` for manual mode: an `input_required` response then
     * surfaces as a typed error unless the individual call opts in with
     * `allowInputRequired: true` (and, for typed results on the explicit
     * schema path, `withInputRequired()`).
     *
     * @default true
     */
    autoFulfill?: boolean;

    /**
     * Maximum number of rounds (retries) the driver performs for a single
     * call before failing with a typed
     * {@linkcode SdkErrorCode.InputRequiredRoundsExceeded} error.
     *
     * @default 10
     */
    maxRounds?: number;
}

/** The driver configuration with defaults applied. */
export interface ResolvedInputRequiredDriverConfig {
    autoFulfill: boolean;
    maxRounds: number;
}

export function resolveInputRequiredDriverConfig(options: InputRequiredOptions | undefined): ResolvedInputRequiredDriverConfig {
    return {
        autoFulfill: options?.autoFulfill ?? DEFAULT_INPUT_REQUIRED_AUTO_FULFILL,
        maxRounds: options?.maxRounds ?? DEFAULT_INPUT_REQUIRED_MAX_ROUNDS
    };
}

/** The discriminated `input_required` payload the wire codec hands to the driver. */
export interface InputRequiredPayload {
    inputRequests: Record<string, unknown>;
    requestState?: string;
}

/** The slice of per-request options the driver consumes. */
export interface InputRequiredDriverRequestOptions {
    timeout?: number;
    maxTotalTimeout?: number;
    onprogress?: (progress: Progress) => void;
}

/** Per-leg options the driver passes back to the funnel for each retry. */
export interface InputRequiredRetryLegOptions {
    timeout?: number;
    maxTotalTimeout?: number;
}

/** The hooks the engine provides to the driver. */
export interface InputRequiredDriverHooks {
    /**
     * Dispatches one embedded input request to the locally registered handler
     * and resolves with the bare response value. Rejections fail the whole
     * call (typed errors: unknown kind, missing handler, handler failure).
     * The signal is the per-round abort: when one sibling fails (or the
     * caller aborts the originating call) the remaining dispatches are
     * cancelled.
     */
    dispatchInputRequest(key: string, entry: unknown, signal: AbortSignal): Promise<unknown>;

    /**
     * Re-issues the original request with the given params on a fresh request
     * id, using the manual primitive: a complete result resolves validated,
     * and a further `input_required` response resolves as the raw
     * input-required value (never recursing into another driver run).
     */
    retry(params: Record<string, unknown> | undefined, legOptions: InputRequiredRetryLegOptions): Promise<unknown>;
}

/** Builds the retry params: original params + this round's responses + byte-exact requestState echo. */
export function buildInputRequiredRetryParams(
    originalParams: Record<string, unknown> | undefined,
    responses: Record<string, unknown> | undefined,
    requestState: string | undefined
): Record<string, unknown> | undefined {
    const hasResponses = responses !== undefined && Object.keys(responses).length > 0;
    if (!hasResponses && requestState === undefined) {
        return originalParams;
    }
    return {
        ...originalParams,
        ...(hasResponses && { inputResponses: responses }),
        // Byte-exact echo: the opaque string is copied verbatim, never parsed.
        // When the result carried no requestState, the retry carries none.
        ...(requestState !== undefined && { requestState })
    };
}

/**
 * Abortable delay: resolves after `ms`, or rejects with the signal's reason
 * (wrapped in an `SdkError` when it isn't already one) if the signal aborts
 * first. Aborting after resolution is a no-op.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal.reason)));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal?.reason)));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * A per-round abort linked to the caller's signal: the embedded sibling
 * dispatches share it, so the first failure (or a caller abort) cancels the
 * others instead of leaving them running.
 */
function linkedRoundAbort(outer: AbortSignal | undefined): { signal: AbortSignal; abort: (reason: unknown) => void; dispose: () => void } {
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort(outer?.reason);
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    if (outer?.aborted) controller.abort(outer.reason);
    return {
        signal: controller.signal,
        abort: reason => controller.abort(reason),
        dispose: () => outer?.removeEventListener('abort', onOuterAbort)
    };
}

/**
 * Runs the auto-fulfilment loop for one originating request. Resolves with
 * the final complete result (already validated by the retry leg) or rejects
 * with a typed error.
 *
 * `flowStartedAt` is the timestamp the ORIGINAL request was issued at (not
 * when the driver started): `maxTotalTimeout` bounds the whole flow, so the
 * first wire leg counts against the budget too. When omitted, accounting
 * starts when the driver starts.
 */
export async function runInputRequiredDriver(args: {
    config: ResolvedInputRequiredDriverConfig;
    method: string;
    originalParams: Record<string, unknown> | undefined;
    firstPayload: InputRequiredPayload;
    requestOptions: InputRequiredDriverRequestOptions;
    hooks: InputRequiredDriverHooks;
    /** The originating call's abort signal — chains through every round and the pacing sleep. */
    signal?: AbortSignal;
    flowStartedAt?: number;
}): Promise<unknown> {
    const { config, method, originalParams, requestOptions, hooks, signal } = args;
    const startedAt = args.flowStartedAt ?? Date.now();
    let payload = args.firstPayload;
    let round = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        round += 1;
        if (round > config.maxRounds) {
            throw new SdkError(
                SdkErrorCode.InputRequiredRoundsExceeded,
                `Multi-round-trip request '${method}' still required input after ${config.maxRounds} rounds (inputRequired.maxRounds)`,
                {
                    rounds: config.maxRounds,
                    lastResult: {
                        inputRequests: payload.inputRequests,
                        ...(payload.requestState !== undefined && { requestState: payload.requestState })
                    }
                }
            );
        }

        // Surface the round as synthetic progress: long interactive flows stay
        // observable, and consumers composing `resetTimeoutOnProgress`-style
        // watchdogs around the call see liveness instead of silence.
        requestOptions.onprogress?.({ progress: round, message: `Fulfilling input required by '${method}' (round ${round})` });

        const entries = Object.entries(payload.inputRequests ?? {});
        let responses: Record<string, unknown> | undefined;
        if (entries.length > 0) {
            // Fulfil concurrently (the embedded requests are independent); a
            // single failure fails the call AND aborts the siblings via the
            // linked per-round signal so they do not keep running.
            const round = linkedRoundAbort(signal);
            try {
                const fulfilled = await Promise.all(
                    entries.map(async ([key, entry]) => {
                        try {
                            return [key, await hooks.dispatchInputRequest(key, entry, round.signal)] as const;
                        } catch (error) {
                            round.abort(error);
                            throw error;
                        }
                    })
                );
                responses = Object.fromEntries(fulfilled);
            } finally {
                round.dispose();
            }
        } else {
            // requestState-only (load-shedding) leg: fixed pacing so the loop
            // never hot-spins; counted in the same round cap. The sleep
            // honors the caller's abort signal.
            await sleep(REQUEST_STATE_ONLY_LEG_PACING_MS, signal);
        }

        const legOptions: InputRequiredRetryLegOptions = {
            ...(requestOptions.timeout !== undefined && { timeout: requestOptions.timeout })
        };
        if (requestOptions.maxTotalTimeout !== undefined) {
            const totalElapsed = Date.now() - startedAt;
            const remaining = requestOptions.maxTotalTimeout - totalElapsed;
            if (remaining <= 0) {
                throw new SdkError(SdkErrorCode.RequestTimeout, 'Maximum total timeout exceeded', {
                    maxTotalTimeout: requestOptions.maxTotalTimeout,
                    totalElapsed
                });
            }
            legOptions.maxTotalTimeout = remaining;
        }

        const result = await hooks.retry(buildInputRequiredRetryParams(originalParams, responses, payload.requestState), legOptions);
        if (isInputRequiredResult(result)) {
            payload = {
                inputRequests: result.inputRequests ?? {},
                ...(result.requestState !== undefined && { requestState: result.requestState })
            };
            continue;
        }
        return result;
    }
}
