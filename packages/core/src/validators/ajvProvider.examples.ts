/**
 * Type-checked examples for `ajvProvider.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { addFormats, Ajv, AjvJsonSchemaValidator } from './ajvProvider.js';

/**
 * Example: Default AJV instance.
 */
function AjvJsonSchemaValidator_default() {
    //#region AjvJsonSchemaValidator_default
    const validator = new AjvJsonSchemaValidator();
    //#endregion AjvJsonSchemaValidator_default
    return validator;
}

/**
 * Example: Custom AJV instance.
 */
function AjvJsonSchemaValidator_customInstance() {
    //#region AjvJsonSchemaValidator_customInstance
    const ajv = new Ajv({ strict: true, allErrors: true });
    const validator = new AjvJsonSchemaValidator(ajv);
    //#endregion AjvJsonSchemaValidator_customInstance
    return validator;
}

/**
 * Example: Custom AJV instance with formats registered.
 *
 * `Ajv` and `addFormats` are re-exported from this module so customising the validator
 * requires no extra `package.json` dependencies — both come from the SDK's bundled copy.
 */
function AjvJsonSchemaValidator_withFormats() {
    //#region AjvJsonSchemaValidator_withFormats
    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    const validator = new AjvJsonSchemaValidator(ajv);
    //#endregion AjvJsonSchemaValidator_withFormats
    return validator;
}
