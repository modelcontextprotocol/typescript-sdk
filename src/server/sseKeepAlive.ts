/** Default interval between SSE keep-alive comment frames. */
export const DEFAULT_SSE_KEEP_ALIVE_MS = 15_000;

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Arms an unref'd timer, or disables keep-alive for invalid delays. */
export function armSseKeepAlive(intervalMs: number, onTick: () => void): ReturnType<typeof setInterval> | undefined {
    if (!Number.isFinite(intervalMs) || intervalMs < 1) {
        return undefined;
    }

    const timer = setInterval(onTick, Math.min(intervalMs, MAX_TIMER_DELAY_MS));
    (timer as { unref?: () => void }).unref?.();
    return timer;
}
