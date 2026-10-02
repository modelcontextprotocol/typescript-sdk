/**
 * The multi-round-trip auto-fulfilment driver loop in isolation (M4.1):
 * round accounting against the configurable cap, retry-param construction
 * (byte-exact requestState echo, bare responses), requestState-only pacing,
 * the existing-knob total-timeout bound, and the typed rounds-exceeded error
 * carrying the last result.
 */
import { describe, expect, test, vi } from 'vitest';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors';
import {
    buildInputRequiredRetryParams,
    DEFAULT_INPUT_REQUIRED_AUTO_FULFILL,
    DEFAULT_INPUT_REQUIRED_MAX_ROUNDS,
    REQUEST_STATE_ONLY_LEG_PACING_MS,
    resolveInputRequiredDriverConfig,
    runInputRequiredDriver
} from '../../src/shared/inputRequiredDriver';

const ELICIT_ENTRY = { method: 'elicitation/create', params: { mode: 'form', message: 'Name?' } };

describe('driver configuration', () => {
    test('defaults: auto-fulfilment on, cap 10 rounds', () => {
        expect(DEFAULT_INPUT_REQUIRED_AUTO_FULFILL).toBe(true);
        expect(DEFAULT_INPUT_REQUIRED_MAX_ROUNDS).toBe(10);
        expect(resolveInputRequiredDriverConfig(undefined)).toEqual({ autoFulfill: true, maxRounds: 10 });
        expect(resolveInputRequiredDriverConfig({ autoFulfill: false, maxRounds: 3 })).toEqual({ autoFulfill: false, maxRounds: 3 });
    });
});

describe('retry params', () => {
    test('echoes requestState byte-exact and attaches bare responses without touching original params', () => {
        const original = { name: 'deploy', arguments: { env: 'prod' } };
        const params = buildInputRequiredRetryParams(original, { confirm: { action: 'accept', content: { ok: true } } }, 'opaqueÿ☃');
        expect(params).toEqual({
            name: 'deploy',
            arguments: { env: 'prod' },
            inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
            requestState: 'opaqueÿ☃'
        });
        // The original params object is not mutated.
        expect(original).toEqual({ name: 'deploy', arguments: { env: 'prod' } });
    });

    test('omits requestState when the result carried none, and inputResponses when nothing was fulfilled', () => {
        expect(buildInputRequiredRetryParams({ name: 'x' }, undefined, 'state')).toEqual({ name: 'x', requestState: 'state' });
        expect(buildInputRequiredRetryParams({ name: 'x' }, {}, undefined)).toEqual({ name: 'x' });
        expect(buildInputRequiredRetryParams(undefined, undefined, undefined)).toBeUndefined();
    });
});

describe('driver loop', () => {
    test('fulfils embedded requests, retries, and resolves with the complete result', async () => {
        const dispatched: string[] = [];
        const retries: Array<Record<string, unknown> | undefined> = [];
        const result = await runInputRequiredDriver({
            config: { autoFulfill: true, maxRounds: 10 },
            method: 'tools/call',
            originalParams: { name: 'deploy' },
            firstPayload: { inputRequests: { confirm: ELICIT_ENTRY }, requestState: 'round-1' },
            requestOptions: {},
            hooks: {
                dispatchInputRequest: (key, _entry) => {
                    dispatched.push(key);
                    return Promise.resolve({ action: 'accept', content: { ok: true } });
                },
                retry: params => {
                    retries.push(params);
                    return Promise.resolve({ content: [{ type: 'text', text: 'done' }] });
                }
            }
        });

        expect(result).toEqual({ content: [{ type: 'text', text: 'done' }] });
        expect(dispatched).toEqual(['confirm']);
        expect(retries).toEqual([
            {
                name: 'deploy',
                inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
                requestState: 'round-1'
            }
        ]);
    });

    test('keeps looping while retries return input_required and counts every leg against the cap', async () => {
        let retryCount = 0;
        const result = await runInputRequiredDriver({
            config: { autoFulfill: true, maxRounds: 3 },
            method: 'tools/call',
            originalParams: { name: 'deploy' },
            firstPayload: { inputRequests: { confirm: ELICIT_ENTRY } },
            requestOptions: {},
            hooks: {
                dispatchInputRequest: () => Promise.resolve({ action: 'accept', content: {} }),
                retry: () => {
                    retryCount += 1;
                    if (retryCount < 3) {
                        return Promise.resolve({ resultType: 'input_required', inputRequests: { confirm: ELICIT_ENTRY } });
                    }
                    return Promise.resolve({ content: [] });
                }
            }
        });
        expect(result).toEqual({ content: [] });
        expect(retryCount).toBe(3);
    });

    test('round exhaustion raises the typed error carrying the last input_required payload', async () => {
        const outcome = runInputRequiredDriver({
            config: { autoFulfill: true, maxRounds: 2 },
            method: 'prompts/get',
            originalParams: { name: 'p' },
            firstPayload: { inputRequests: { confirm: ELICIT_ENTRY }, requestState: 'state-0' },
            requestOptions: {},
            hooks: {
                dispatchInputRequest: () => Promise.resolve({ action: 'accept' }),
                retry: () =>
                    Promise.resolve({ resultType: 'input_required', inputRequests: { again: ELICIT_ENTRY }, requestState: 'state-n' })
            }
        });
        await expect(outcome).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(SdkError);
            const typed = error as SdkError;
            expect(typed.code).toBe(SdkErrorCode.InputRequiredRoundsExceeded);
            expect(typed.data).toMatchObject({
                rounds: 2,
                lastResult: { inputRequests: { again: ELICIT_ENTRY }, requestState: 'state-n' }
            });
            return true;
        });
    });

    test('a requestState-only leg is paced by the fixed delay and counted in the same cap', async () => {
        vi.useFakeTimers();
        try {
            let resolved = false;
            const run = runInputRequiredDriver({
                config: { autoFulfill: true, maxRounds: 10 },
                method: 'tools/call',
                originalParams: { name: 'x' },
                firstPayload: { inputRequests: {}, requestState: 'only-state' },
                requestOptions: {},
                hooks: {
                    dispatchInputRequest: () => Promise.reject(new Error('must not dispatch on a state-only leg')),
                    retry: params => {
                        expect(params).toEqual({ name: 'x', requestState: 'only-state' });
                        return Promise.resolve({ content: [] });
                    }
                }
            }).then(value => {
                resolved = true;
                return value;
            });

            // Nothing happens before the pacing delay elapses.
            await vi.advanceTimersByTimeAsync(REQUEST_STATE_ONLY_LEG_PACING_MS - 1);
            expect(resolved).toBe(false);
            await vi.advanceTimersByTimeAsync(2);
            await expect(run).resolves.toEqual({ content: [] });
        } finally {
            vi.useRealTimers();
        }
    });

    test('maxTotalTimeout bounds the whole flow through the existing knob (shrinking per-leg budgets)', async () => {
        const legBudgets: Array<number | undefined> = [];
        let now = 0;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const outcome = runInputRequiredDriver({
                config: { autoFulfill: true, maxRounds: 10 },
                method: 'tools/call',
                originalParams: { name: 'x' },
                firstPayload: { inputRequests: { confirm: ELICIT_ENTRY } },
                requestOptions: { timeout: 1_000, maxTotalTimeout: 5_000 },
                hooks: {
                    dispatchInputRequest: () => {
                        // Handler time counts against the total budget.
                        now += 3_000;
                        return Promise.resolve({ action: 'accept' });
                    },
                    retry: (_params, legOptions) => {
                        legBudgets.push(legOptions.maxTotalTimeout);
                        return Promise.resolve({ resultType: 'input_required', inputRequests: { confirm: ELICIT_ENTRY } });
                    }
                }
            });
            await expect(outcome).rejects.toSatisfy((error: unknown) => {
                expect(error).toBeInstanceOf(SdkError);
                expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
                return true;
            });
            // First leg got the remaining 2 s of the 5 s budget; the second
            // round's budget was already exhausted before sending.
            expect(legBudgets).toEqual([2_000]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('the total-timeout budget is measured from the flow start (the original request), not the driver start', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 10_000);
        try {
            const retries: unknown[] = [];
            const outcome = runInputRequiredDriver({
                config: { autoFulfill: true, maxRounds: 10 },
                method: 'tools/call',
                originalParams: { name: 'x' },
                firstPayload: { inputRequests: { confirm: ELICIT_ENTRY } },
                requestOptions: { maxTotalTimeout: 5_000 },
                // The original request went out at t=4s; the first wire leg
                // alone already exhausted the 5 s whole-flow budget by t=10s.
                flowStartedAt: 4_000,
                hooks: {
                    dispatchInputRequest: () => Promise.resolve({ action: 'accept' }),
                    retry: params => {
                        retries.push(params);
                        return Promise.resolve({ content: [] });
                    }
                }
            });
            await expect(outcome).rejects.toSatisfy((error: unknown) => {
                expect(error).toBeInstanceOf(SdkError);
                const typed = error as SdkError;
                expect(typed.code).toBe(SdkErrorCode.RequestTimeout);
                expect(typed.data).toMatchObject({ maxTotalTimeout: 5_000, totalElapsed: 6_000 });
                return true;
            });
            // Fail before any retry hits the wire: the budget was already gone.
            expect(retries).toHaveLength(0);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('each round is surfaced as synthetic progress to the caller', async () => {
        const progress: number[] = [];
        await runInputRequiredDriver({
            config: { autoFulfill: true, maxRounds: 10 },
            method: 'resources/read',
            originalParams: { uri: 'file:///x' },
            firstPayload: { inputRequests: { confirm: ELICIT_ENTRY } },
            requestOptions: { onprogress: update => progress.push(update.progress) },
            hooks: {
                dispatchInputRequest: () => Promise.resolve({ action: 'accept' }),
                retry: () => Promise.resolve({ contents: [] })
            }
        });
        expect(progress).toEqual([1]);
    });

    test('a failing embedded dispatch aborts its sibling dispatches via the per-round signal', async () => {
        let siblingSignal: AbortSignal | undefined;
        const siblingSettled = vi.fn();
        const outcome = runInputRequiredDriver({
            config: { autoFulfill: true, maxRounds: 10 },
            method: 'tools/call',
            originalParams: { name: 't' },
            firstPayload: { inputRequests: { fail: ELICIT_ENTRY, slow: ELICIT_ENTRY } },
            requestOptions: {},
            hooks: {
                dispatchInputRequest: (key, _entry, signal) => {
                    if (key === 'fail') {
                        return Promise.reject(new SdkError(SdkErrorCode.CapabilityNotSupported, 'no handler'));
                    }
                    siblingSignal = signal;
                    return new Promise((resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            siblingSettled();
                            reject(signal.reason);
                        });
                    });
                },
                retry: () => Promise.resolve({ content: [] })
            }
        });
        await expect(outcome).rejects.toMatchObject({ code: SdkErrorCode.CapabilityNotSupported });
        // The sibling was aborted via the linked per-round signal — it did not
        // keep running after the first failure.
        expect(siblingSignal?.aborted).toBe(true);
        expect(siblingSettled).toHaveBeenCalledOnce();
    });

    test('the requestState-only pacing sleep honors the caller abort signal', async () => {
        const controller = new AbortController();
        const outcome = runInputRequiredDriver({
            config: { autoFulfill: true, maxRounds: 10 },
            method: 'tools/call',
            originalParams: { name: 't' },
            firstPayload: { inputRequests: {}, requestState: 'opaque' },
            requestOptions: {},
            signal: controller.signal,
            hooks: {
                dispatchInputRequest: () => Promise.resolve({}),
                retry: () => Promise.resolve({ content: [] })
            }
        });
        // Abort while the loop is in the 250 ms pacing sleep — the call must
        // settle without waiting it out.
        const aborted = new SdkError(SdkErrorCode.RequestTimeout, 'aborted');
        controller.abort(aborted);
        const start = Date.now();
        await expect(outcome).rejects.toBe(aborted);
        expect(Date.now() - start).toBeLessThan(REQUEST_STATE_ONLY_LEG_PACING_MS);
    });
});
