/**
 * Engine defaults (the engine contract). All per-task configurable via
 * `registerTask` config; steps can further override retries and timeout.
 */

import type { RetryPolicy } from '../step/types';

/** Default task retention: 24 hours from creation. `null` disables the TTL. */
export const DEFAULT_TTL_MS = 86_400_000;

/** Default suggested polling interval: 5 seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Default per-attempt step closure timeout: 5 minutes. */
export const DEFAULT_STEP_TIMEOUT_MS = 300_000;

/**
 * Default step retry policy: 5 total attempts, exponential backoff with
 * jitter from a 1-second base to a 5-minute cap. `limit` counts claims — a
 * crash after a claim consumes an attempt.
 */
export const DEFAULT_RETRY_POLICY = {
    limit: 5,
    baseDelayMs: 1000,
    maxDelayMs: 300_000
} as const satisfies Required<RetryPolicy>;
