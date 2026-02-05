/**
 * Type-checked examples for `express.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { createMcpExpressApp } from './express.js';

/**
 * Example: Basic usage with default DNS rebinding protection.
 */
function createMcpExpressApp_default() {
    //#region createMcpExpressApp_default
    const app = createMcpExpressApp();
    //#endregion createMcpExpressApp_default
    return app;
}

/**
 * Example: Custom host binding with and without DNS rebinding protection.
 */
function createMcpExpressApp_customHost() {
    //#region createMcpExpressApp_customHost
    const appOpen = createMcpExpressApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
    const appLocal = createMcpExpressApp({ host: 'localhost' }); // DNS rebinding protection enabled
    //#endregion createMcpExpressApp_customHost
    return { appOpen, appLocal };
}

/**
 * Example: Custom allowed hosts for non-localhost binding.
 */
function createMcpExpressApp_allowedHosts() {
    //#region createMcpExpressApp_allowedHosts
    const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
    //#endregion createMcpExpressApp_allowedHosts
    return app;
}
