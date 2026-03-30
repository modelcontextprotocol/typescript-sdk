/**
 * Type-checked examples for `streamableHttp.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

/* eslint-disable unicorn/consistent-function-scoping -- examples must live inside region blocks */

import type { ReconnectionScheduler } from './streamableHttp.js';

// Stub for a hypothetical platform-specific background scheduling API
declare const platformBackgroundTask: {
    schedule(callback: () => void, delay: number): number;
    cancel(id: number): void;
};

/**
 * Example: Using a platform background-task API to schedule reconnections.
 */
function ReconnectionScheduler_basicUsage() {
    //#region ReconnectionScheduler_basicUsage
    const scheduler: ReconnectionScheduler = (reconnect, delay) => {
        const id = platformBackgroundTask.schedule(reconnect, delay);
        return () => platformBackgroundTask.cancel(id);
    };
    //#endregion ReconnectionScheduler_basicUsage
    return scheduler;
}
