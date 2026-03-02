/**
 * Type-checked examples for `cfWorkerProvider.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { CfWorkerJsonSchemaValidator } from './cfWorkerProvider.js';

/**
 * Example: Default configuration.
 */
function CfWorkerJsonSchemaValidator_default() {
    //#region CfWorkerJsonSchemaValidator_default
    const validator = new CfWorkerJsonSchemaValidator();
    //#endregion CfWorkerJsonSchemaValidator_default
    return validator;
}

/**
 * Example: Custom configuration with all errors reported.
 */
function CfWorkerJsonSchemaValidator_customConfig() {
    //#region CfWorkerJsonSchemaValidator_customConfig
    const validator = new CfWorkerJsonSchemaValidator({
        draft: '2020-12',
        shortcircuit: false // Report all errors
    });
    //#endregion CfWorkerJsonSchemaValidator_customConfig
    return validator;
}
