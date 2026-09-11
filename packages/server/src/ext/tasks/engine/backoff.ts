/*
 * Backoff utilities for step and invocation retries.
 *
 * Adapted from avenceslau/durability, pinned at commit 78cb099 (v2.1.0):
 * `packages/durability/src/utils.ts` (whole file).
 * https://github.com/avenceslau/durability
 */

/**
 * Calculates a capped exponential retry delay.
 *
 * @param attempt One-based attempt number.
 * @param initialDelayMs Delay after the first failed attempt. Defaults to 1 second.
 * @param maxDelayMs Maximum returned delay. Defaults to 5 minutes.
 */
export const exponential = (attempt: number, initialDelayMs = 1000, maxDelayMs = 300_000): number =>
    Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);

/** Applies equal jitter, returning a value between half and all of the delay. */
export const jitter = (delayMs: number): number => delayMs / 2 + Math.random() * (delayMs / 2);
