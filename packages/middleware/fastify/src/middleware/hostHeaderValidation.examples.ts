/**
 * Type-checked examples for `hostHeaderValidation.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { FastifyInstance } from 'fastify';

import { hostHeaderValidation, localhostHostValidation } from './hostHeaderValidation.js';

/**
 * Example: Using hostHeaderValidation hook with custom allowed hosts.
 */
function hostHeaderValidation_basicUsage(app: FastifyInstance) {
    //#region hostHeaderValidation_basicUsage
    app.addHook('onRequest', hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']));
    //#endregion hostHeaderValidation_basicUsage
}

/**
 * Example: Using localhostHostValidation convenience hook.
 */
function localhostHostValidation_basicUsage(app: FastifyInstance) {
    //#region localhostHostValidation_basicUsage
    app.addHook('onRequest', localhostHostValidation());
    //#endregion localhostHostValidation_basicUsage
}
