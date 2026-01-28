/**
 * Timeout Manager
 *
 * Manages request timeouts for the Protocol class.
 * Extracted from Protocol to follow Single Responsibility Principle.
 */

/**
 * Information about a request's timeout state
 */
export interface TimeoutInfo {
    timeoutId: ReturnType<typeof setTimeout>;
    startTime: number;
    timeout: number;
    maxTotalTimeout?: number;
    resetTimeoutOnProgress: boolean;
    onTimeout: () => void;
}

/**
 * Options for setting up a timeout
 */
export interface TimeoutOptions {
    /**
     * The timeout duration in milliseconds
     */
    timeout: number;

    /**
     * Maximum total time allowed (optional)
     */
    maxTotalTimeout?: number;

    /**
     * Whether to reset the timeout when progress is received
     */
    resetTimeoutOnProgress?: boolean;

    /**
     * Callback to invoke when the timeout expires
     */
    onTimeout: () => void;
}

/**
 * Manages request timeouts for outgoing requests.
 */
export class TimeoutManager {
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();

    /**
     * Sets up a timeout for a message.
     *
     * @param messageId - The unique identifier for the message
     * @param options - Timeout configuration options
     */
    setup(messageId: number, options: TimeoutOptions): void {
        const { timeout, maxTotalTimeout, resetTimeoutOnProgress, onTimeout } = options;

        this._timeoutInfo.set(messageId, {
            timeoutId: setTimeout(onTimeout, timeout),
            startTime: Date.now(),
            timeout,
            maxTotalTimeout,
            resetTimeoutOnProgress: resetTimeoutOnProgress ?? false,
            onTimeout
        });
    }

    /**
     * Resets the timeout for a message (e.g., when progress is received).
     * Returns true if the timeout was reset, false if it wasn't found or
     * if the max total timeout would be exceeded.
     *
     * @param messageId - The message ID whose timeout should be reset
     * @returns true if reset succeeded, false otherwise
     */
    reset(messageId: number): boolean {
        const info = this._timeoutInfo.get(messageId);
        if (!info || !info.resetTimeoutOnProgress) {
            return false;
        }

        const elapsed = Date.now() - info.startTime;

        // Check if max total timeout would be exceeded
        if (info.maxTotalTimeout === undefined) {
            // No max total timeout, just reset with original timeout
            clearTimeout(info.timeoutId);
            info.timeoutId = setTimeout(info.onTimeout, info.timeout);
        } else {
            const remainingTotal = info.maxTotalTimeout - elapsed;
            if (remainingTotal <= 0) {
                // Don't reset, let the timeout fire
                return false;
            }

            // Clear old timeout and set new one with the smaller of:
            // - original timeout
            // - remaining total time
            clearTimeout(info.timeoutId);
            const newTimeout = Math.min(info.timeout, remainingTotal);
            info.timeoutId = setTimeout(info.onTimeout, newTimeout);
        }

        return true;
    }

    /**
     * Cleans up the timeout for a message (e.g., when a response is received).
     *
     * @param messageId - The message ID whose timeout should be cleaned up
     */
    cleanup(messageId: number): void {
        const info = this._timeoutInfo.get(messageId);
        if (info) {
            clearTimeout(info.timeoutId);
            this._timeoutInfo.delete(messageId);
        }
    }

    /**
     * Gets the timeout info for a message.
     *
     * @param messageId - The message ID
     * @returns The timeout info or undefined if not found
     */
    get(messageId: number): TimeoutInfo | undefined {
        return this._timeoutInfo.get(messageId);
    }

    /**
     * Checks if a timeout exists for a message.
     *
     * @param messageId - The message ID
     * @returns true if a timeout exists
     */
    has(messageId: number): boolean {
        return this._timeoutInfo.has(messageId);
    }

    /**
     * Gets the elapsed time for a message's timeout.
     *
     * @param messageId - The message ID
     * @returns The elapsed time in milliseconds, or undefined if not found
     */
    getElapsed(messageId: number): number | undefined {
        const info = this._timeoutInfo.get(messageId);
        if (!info) {
            return undefined;
        }
        return Date.now() - info.startTime;
    }

    /**
     * Clears all timeouts.
     */
    clearAll(): void {
        for (const info of this._timeoutInfo.values()) {
            clearTimeout(info.timeoutId);
        }
        this._timeoutInfo.clear();
    }

    /**
     * Gets the number of active timeouts.
     */
    get size(): number {
        return this._timeoutInfo.size;
    }
}
