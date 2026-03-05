/**
 * Type-checked examples for `index.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { AjvJsonSchemaValidator } from './validation/ajvProvider.js';
import { CfWorkerJsonSchemaValidator } from './validation/cfWorkerProvider.js';

/**
 * Example: AJV validator for Node.js.
 */
function validation_ajv() {
    //#region validation_ajv
    const validator = new AjvJsonSchemaValidator();
    //#endregion validation_ajv
    return validator;
}

/**
 * Example: CfWorker validator for edge runtimes.
 */
function validation_cfWorker() {
    //#region validation_cfWorker
    const validator = new CfWorkerJsonSchemaValidator();
    //#endregion validation_cfWorker
    return validator;
}
