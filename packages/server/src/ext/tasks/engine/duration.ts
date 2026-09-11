/**
 * Duration-string parsing for `step.sleep` (`"30s" | "5m" | "1h" | "2d"` or a
 * plain number of milliseconds).
 */

const UNIT_MS = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
} as const;

export type DurationUnit = keyof typeof UNIT_MS;

/** A duration literal such as `"30s"`, `"5m"`, `"1h"`, `"2d"`, or `"250ms"`. */
export type DurationString = `${number}${DurationUnit}`;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;

/**
 * Parses a duration into integer milliseconds.
 *
 * Numbers are taken as milliseconds and must be finite and non-negative.
 * Strings must match `<number><ms|s|m|h|d>` with a non-negative value.
 * Fractional results are rounded to the nearest millisecond.
 *
 * @throws RangeError on negative, non-finite, or malformed input.
 */
export function parseDuration(duration: number | DurationString): number {
    if (typeof duration === 'number') {
        if (!Number.isFinite(duration) || duration < 0) {
            throw new RangeError(`Duration must be a non-negative finite number of milliseconds, got ${duration}`);
        }
        return Math.round(duration);
    }
    const match = DURATION_PATTERN.exec(duration);
    if (match === null) {
        throw new RangeError(`Invalid duration "${duration}" — expected forms like "30s", "5m", "1h", "2d", or "250ms"`);
    }
    const [, value = '', unit = 'ms'] = match;
    return Math.round(Number(value) * UNIT_MS[unit as DurationUnit]);
}
