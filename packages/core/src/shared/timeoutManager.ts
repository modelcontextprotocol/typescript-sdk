/**
 * Timeout Manager
 *
 * Manages request timeouts for the Protocol class.
 * Extracted from Protocol to follow Single Responsibility Principle.
 */

/**
 * Information about a request's timeout state.
 */
export interface TimeoutInfo {
    /**
     * The timeout ID returned by setTimeout.
     */
    timeoutId: ReturnType<typeof setTimeout>;

    /**
     * The time when the timeout was started (in milliseconds since epoch).
     */
    startTime: number;

    /**
     * The timeout duration in milliseconds.
     */
    timeout: number;

    /**
     * Maximum total time allowed in milliseconds (optional).
     */
    maxTotalTimeout?: number;

    /**
     * Whether to reset the timeout when progress is received.
     */
    resetTimeoutOnProgress: boolean;

    /**
     * Callback to invoke when the timeout expires.
     */
    onTimeout: () => void;
}

/**
 * Options for setting up a timeout.
 */
export interface TimeoutOptions {
    /**
     * The timeout duration in milliseconds.
     */
    timeout: number;

    /**
     * Maximum total time allowed in milliseconds (optional).
     * If set, the timeout cannot be reset beyond this total duration.
     */
    maxTotalTimeout?: number;

    /**
     * Whether to reset the timeout when progress is received.
     * @default false
     */
    resetTimeoutOnProgress?: boolean;

    /**
     * Callback to invoke when the timeout expires.
     */
    onTimeout: () => void;
}

/**
 * Result of a timeout reset attempt.
 */
export interface TimeoutResetResult {
    /**
     * Whether the reset was successful.
     */
    success: boolean;

    /**
     * If reset failed due to max total timeout being exceeded, this contains
     * the elapsed time and max total timeout for error reporting.
     */
    maxTotalTimeoutExceeded?: {
        elapsed: number;
        maxTotalTimeout: number;
    };
}

/**
 * Manages request timeouts for outgoing requests.
 *
 * This class handles setting up, resetting, and cleaning up timeouts for
 * individual messages. It supports both simple timeouts and progress-aware
 * timeouts that can be reset when progress notifications are received.
 *
 * @example
 * ```typescript
 * const timeoutManager = new TimeoutManager();
 *
 * // Set up a timeout
 * timeoutManager.setup(messageId, {
 *   timeout: 30000,
 *   maxTotalTimeout: 300000,
 *   resetTimeoutOnProgress: true,
 *   onTimeout: () => console.log('Request timed out')
 * });
 *
 * // Reset timeout when progress is received
 * const result = timeoutManager.reset(messageId);
 * if (!result.success && result.maxTotalTimeoutExceeded) {
 *   // Handle max total timeout exceeded
 * }
 *
 * // Clean up when response received
 * timeoutManager.cleanup(messageId);
 * ```
 */
export class TimeoutManager {
    /**
     * Maps message IDs to their timeout information.
     */
    #timeoutInfo: Map<number, TimeoutInfo> = new Map();

    /**
     * Sets up a timeout for a message.
     *
     * @param messageId - The unique identifier for the message
     * @param options - Timeout configuration options
     */
    setup(messageId: number, options: TimeoutOptions): void {
        const { timeout, maxTotalTimeout, resetTimeoutOnProgress, onTimeout } = options;

        this.#timeoutInfo.set(messageId, {
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
     *
     * The reset will fail if:
     * - No timeout exists for the message
     * - The timeout is not configured for reset on progress
     * - The max total timeout has been exceeded
     *
     * When reset succeeds, the timeout is reset to its original duration.
     * The maxTotalTimeout check happens when reset is called, not by setting
     * a shorter timeout - this allows progress notifications to be processed
     * and the caller to handle the max total timeout exceeded condition.
     *
     * @param messageId - The message ID whose timeout should be reset
     * @returns A result object indicating success or failure with details
     */
    reset(messageId: number): TimeoutResetResult {
        const info = this.#timeoutInfo.get(messageId);
        if (!info || !info.resetTimeoutOnProgress) {
            return { success: false };
        }

        const elapsed = Date.now() - info.startTime;

        // Check if max total timeout has been exceeded
        if (info.maxTotalTimeout !== undefined && elapsed >= info.maxTotalTimeout) {
            return {
                success: false,
                maxTotalTimeoutExceeded: {
                    elapsed,
                    maxTotalTimeout: info.maxTotalTimeout
                }
            };
        }

        // Reset to the original timeout duration
        clearTimeout(info.timeoutId);
        info.timeoutId = setTimeout(info.onTimeout, info.timeout);

        return { success: true };
    }

    /**
     * Cleans up the timeout for a message (e.g., when a response is received).
     *
     * @param messageId - The message ID whose timeout should be cleaned up
     */
    cleanup(messageId: number): void {
        const info = this.#timeoutInfo.get(messageId);
        if (info) {
            clearTimeout(info.timeoutId);
            this.#timeoutInfo.delete(messageId);
        }
    }

    /**
     * Gets the timeout info for a message.
     *
     * @param messageId - The message ID
     * @returns The timeout info or undefined if not found
     */
    get(messageId: number): TimeoutInfo | undefined {
        return this.#timeoutInfo.get(messageId);
    }

    /**
     * Checks if a timeout exists for a message.
     *
     * @param messageId - The message ID
     * @returns true if a timeout exists
     */
    has(messageId: number): boolean {
        return this.#timeoutInfo.has(messageId);
    }

    /**
     * Gets the elapsed time for a message's timeout.
     *
     * @param messageId - The message ID
     * @returns The elapsed time in milliseconds, or undefined if not found
     */
    getElapsed(messageId: number): number | undefined {
        const info = this.#timeoutInfo.get(messageId);
        if (!info) {
            return undefined;
        }
        return Date.now() - info.startTime;
    }

    /**
     * Clears all timeouts.
     * Typically called when the connection is closed.
     */
    clearAll(): void {
        for (const info of this.#timeoutInfo.values()) {
            clearTimeout(info.timeoutId);
        }
        this.#timeoutInfo.clear();
    }

    /**
     * Gets the number of active timeouts.
     */
    get size(): number {
        return this.#timeoutInfo.size;
    }
}
