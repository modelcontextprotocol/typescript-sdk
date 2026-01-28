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
 * Interface for progress management.
 * Plugins use this interface to register and manage progress handlers.
 */
export interface ProgressManagerInterface {
    /**
     * Registers a progress callback for a message.
     * @param messageId - The message ID (used as progress token)
     * @param callback - The callback to invoke when progress is received
     */
    registerHandler(messageId: number, callback: ProgressCallback): void;

    /**
     * Gets the progress callback for a message.
     * @param messageId - The message ID
     * @returns The progress callback or undefined
     */
    getHandler(messageId: number): ProgressCallback | undefined;

    /**
     * Removes the progress callback for a message.
     * @param messageId - The message ID
     */
    removeHandler(messageId: number): void;

    /**
     * Handles an incoming progress notification.
     * @param notification - The progress notification
     * @returns true if handled, false if no handler was found
     */
    handleProgress(notification: ProgressNotification): boolean;
}

/**
 * Manages progress tracking for requests.
 */
export class ProgressManager implements ProgressManagerInterface {
    /**
     * Maps message IDs to progress callbacks
     */
    private _progressHandlers: Map<number, ProgressCallback> = new Map();

    /**
     * Registers a progress callback for a message.
     *
     * @param messageId - The message ID (used as progress token)
     * @param callback - The callback to invoke when progress is received
     */
    registerHandler(messageId: number, callback: ProgressCallback): void {
        this._progressHandlers.set(messageId, callback);
    }

    /**
     * Gets the progress callback for a message.
     *
     * @param messageId - The message ID
     * @returns The progress callback or undefined
     */
    getHandler(messageId: number): ProgressCallback | undefined {
        return this._progressHandlers.get(messageId);
    }

    /**
     * Removes the progress callback for a message.
     *
     * @param messageId - The message ID
     */
    removeHandler(messageId: number): void {
        this._progressHandlers.delete(messageId);
    }

    /**
     * Handles an incoming progress notification.
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

        const callback = this._progressHandlers.get(token);
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
     * Clears all progress handlers.
     */
    clear(): void {
        this._progressHandlers.clear();
    }

    /**
     * Gets the number of active progress handlers.
     */
    get handlerCount(): number {
        return this._progressHandlers.size;
    }
}
