/**
 * Type-checked examples for `fastify.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { createMcpFastifyApp } from './fastify.js';

/**
 * Example: Basic usage with default DNS rebinding protection.
 */
function createMcpFastifyApp_default() {
    //#region createMcpFastifyApp_default
    const app = createMcpFastifyApp();
    //#endregion createMcpFastifyApp_default
    return app;
}

/**
 * Example: Custom host binding with and without DNS rebinding protection.
 */
function createMcpFastifyApp_customHost() {
    //#region createMcpFastifyApp_customHost
    const appOpen = createMcpFastifyApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
    const appLocal = createMcpFastifyApp({ host: 'localhost' }); // DNS rebinding protection enabled
    //#endregion createMcpFastifyApp_customHost
    return { appOpen, appLocal };
}

/**
 * Example: Custom allowed hosts for non-localhost binding.
 */
function createMcpFastifyApp_allowedHosts() {
    //#region createMcpFastifyApp_allowedHosts
    const app = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
    //#endregion createMcpFastifyApp_allowedHosts
    return app;
}
