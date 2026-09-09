import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { armSseKeepAlive } from '../../src/server/sseKeepAlive';

describe('armSseKeepAlive', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('disables invalid delay %s', delay => {
        expect(armSseKeepAlive(delay, () => {})).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ticks at the configured interval', async () => {
        const tick = vi.fn();
        const timer = armSseKeepAlive(1_000, tick)!;
        await vi.advanceTimersByTimeAsync(3_000);
        expect(tick).toHaveBeenCalledTimes(3);
        clearInterval(timer);
    });

    it('clamps overflowing delays instead of creating a 1ms timer', async () => {
        const tick = vi.fn();
        const timer = armSseKeepAlive(2 ** 31, tick)!;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(tick).not.toHaveBeenCalled();
        clearInterval(timer);
    });
});
