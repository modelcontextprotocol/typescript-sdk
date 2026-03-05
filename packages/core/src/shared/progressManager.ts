/**
 * Progress Manager
 *
 * Manages progress tracking for the Protocol class.
 * Extracted from Protocol to follow Single Responsibility Principle.
 */

import type { Progress, ProgressNotification } from '../types/types.js';

/**
 * Callback for progress notifications.
 */
export type ProgressCallback = (progress: Progress) => void;

/**
 * Manages progress tracking for requests.
 *
 * This class handles registration, lookup, and invocation of progress callbacks,
 * as well as task-to-progress-token associations for long-running task operations.
 *
 * @example
 * ```typescript
 * const progressManager = new ProgressManager();
 *
 * // Register a progress handler for a request
 * progressManager.registerHandler(messageId, (progress) => {
 *   console.log(`Progress: ${progress.progress}/${progress.total}`);
 * });
 *
 * // Handle incoming progress notification
 * progressManager.handleProgress(notification);
 *
 * // Clean up when done
 * progressManager.removeHandler(messageId);
 * ```
 */
export class ProgressManager {
    /**
     * Maps message IDs to progress callbacks.
     */
    #progressHandlers: Map<number, ProgressCallback> = new Map();

    /**
     * Maps task IDs to progress tokens to keep handlers alive after CreateTaskResult.
     */
    #taskProgressTokens: Map<string, number> = new Map();

    /**
     * Registers a progress callback for a message.
     *
     * @param messageId - The message ID (used as progress token)
     * @param callback - The callback to invoke when progress is received
     */
    registerHandler(messageId: number, callback: ProgressCallback): void {
        this.#progressHandlers.set(messageId, callback);
    }

    /**
     * Gets the progress callback for a message.
     *
     * @param messageId - The message ID
     * @returns The progress callback or undefined if not registered
     */
    getHandler(messageId: number): ProgressCallback | undefined {
        return this.#progressHandlers.get(messageId);
    }

    /**
     * Removes the progress callback for a message.
     *
     * @param messageId - The message ID
     */
    removeHandler(messageId: number): void {
        this.#progressHandlers.delete(messageId);
    }

    /**
     * Checks if a progress handler exists for the given message ID.
     *
     * @param messageId - The message ID
     * @returns true if a handler is registered, false otherwise
     */
    hasHandler(messageId: number): boolean {
        return this.#progressHandlers.has(messageId);
    }

    /**
     * Handles an incoming progress notification by invoking the registered callback.
     * Returns true if the progress was handled, false if no handler was found.
     *
     * @param notification - The progress notification
     * @returns true if handled, false otherwise
     */
    handleProgress(notification: ProgressNotification): boolean {
        const token = notification.params.progressToken;
        if (typeof token !== 'number') {
            // Token must be a number for our internal tracking
            return false;
        }

        const callback = this.#progressHandlers.get(token);
        if (callback) {
            callback({
                progress: notification.params.progress,
                total: notification.params.total,
                message: notification.params.message
            });
            return true;
        }

        return false;
    }

    /**
     * Links a task ID to a progress token.
     * This keeps the progress handler alive after CreateTaskResult is returned,
     * allowing progress notifications to continue for long-running tasks.
     *
     * @param taskId - The task identifier
     * @param progressToken - The progress token (message ID)
     */
    linkTaskToProgressToken(taskId: string, progressToken: number): void {
        this.#taskProgressTokens.set(taskId, progressToken);
    }

    /**
     * Gets the progress token associated with a task.
     *
     * @param taskId - The task identifier
     * @returns The progress token or undefined if not linked
     */
    getTaskProgressToken(taskId: string): number | undefined {
        return this.#taskProgressTokens.get(taskId);
    }

    /**
     * Cleans up the progress handler associated with a task.
     * Should be called when a task reaches a terminal status.
     *
     * @param taskId - The task identifier
     */
    cleanupTaskProgressHandler(taskId: string): void {
        const progressToken = this.#taskProgressTokens.get(taskId);
        if (progressToken !== undefined) {
            this.#progressHandlers.delete(progressToken);
            this.#taskProgressTokens.delete(taskId);
        }
    }

    /**
     * Clears all progress handlers and task progress tokens.
     * Typically called when the connection is closed.
     */
    clear(): void {
        this.#progressHandlers.clear();
        this.#taskProgressTokens.clear();
    }

    /**
     * Gets the number of active progress handlers.
     */
    get handlerCount(): number {
        return this.#progressHandlers.size;
    }

    /**
     * Gets the number of active task-to-progress-token links.
     */
    get taskTokenCount(): number {
        return this.#taskProgressTokens.size;
    }
}
