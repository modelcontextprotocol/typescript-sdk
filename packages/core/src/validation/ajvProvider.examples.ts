/**
 * Type-checked examples for `ajvProvider.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { Ajv } from 'ajv';
import _addFormats from 'ajv-formats';

import { AjvJsonSchemaValidator } from './ajvProvider.js';

const addFormats = _addFormats as unknown as typeof _addFormats.default;

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
 * Example: Constructor with advanced AJV configuration including formats.
 */
function AjvJsonSchemaValidator_constructor_withFormats() {
    //#region AjvJsonSchemaValidator_constructor_withFormats
    const ajv = new Ajv({ validateFormats: true });
    addFormats(ajv);
    const validator = new AjvJsonSchemaValidator(ajv);
    //#endregion AjvJsonSchemaValidator_constructor_withFormats
    return validator;
}
