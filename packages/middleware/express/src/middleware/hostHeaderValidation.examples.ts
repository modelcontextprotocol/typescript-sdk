/**
 * Type-checked examples for `hostHeaderValidation.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { Express } from 'express';

import { hostHeaderValidation, localhostHostValidation } from './hostHeaderValidation.js';

/**
 * Example: Using hostHeaderValidation middleware with custom allowed hosts.
 */
function hostHeaderValidation_basicUsage(app: Express) {
    //#region hostHeaderValidation_basicUsage
    const middleware = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']);
    app.use(middleware);
    //#endregion hostHeaderValidation_basicUsage
}

/**
 * Example: Using localhostHostValidation convenience middleware.
 */
function localhostHostValidation_basicUsage(app: Express) {
    //#region localhostHostValidation_basicUsage
    app.use(localhostHostValidation());
    //#endregion localhostHostValidation_basicUsage
}
