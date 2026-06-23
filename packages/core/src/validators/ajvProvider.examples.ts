/**
 * Type-checked examples for `ajvProvider.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { Ajv2020 } from 'ajv/dist/2020.js';

import { addFormats, AjvJsonSchemaValidator } from './ajvProvider.js';

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
 *
 * The SDK bundles ajv internally but does not re-export `Ajv2020` (its type graph tips downstream
 * declaration bundling — see #2339). To construct a custom 2020-12 instance, add `ajv` to your own
 * dependencies (matching the SDK's pinned version) and `import { Ajv2020 } from 'ajv/dist/2020.js'`
 * so the custom instance keeps validating JSON Schema 2020-12 (SEP-1613). Passing `new Ajv(...)`
 * (the draft-07 class) would silently downgrade dialect.
 */
function AjvJsonSchemaValidator_customInstance() {
    //#region AjvJsonSchemaValidator_customInstance
    // import { Ajv2020 } from 'ajv/dist/2020.js';
    const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true });
    const validator = new AjvJsonSchemaValidator(ajv);
    //#endregion AjvJsonSchemaValidator_customInstance
    return validator;
}

/**
 * Example: Custom AJV instance with formats registered.
 *
 * `addFormats` is re-exported from this module. The SDK bundles ajv internally but does not
 * re-export `Ajv2020` (its type graph tips downstream declaration bundling — see #2339). To
 * construct a custom 2020-12 instance, add `ajv` to your own dependencies (matching the SDK's
 * pinned version) and `import { Ajv2020 } from 'ajv/dist/2020.js'`.
 */
function AjvJsonSchemaValidator_withFormats() {
    //#region AjvJsonSchemaValidator_withFormats
    // import { Ajv2020 } from 'ajv/dist/2020.js';
    const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true });
    addFormats(ajv);
    const validator = new AjvJsonSchemaValidator(ajv);
    //#endregion AjvJsonSchemaValidator_withFormats
    return validator;
}
