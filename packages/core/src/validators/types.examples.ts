/**
 * Type-checked examples for `types.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from './types.js';

// Stub for hypothetical schema validation function
declare function isValid(schema: JsonSchemaType, input: unknown): boolean;

/**
 * Example: Implementing the jsonSchemaValidator interface.
 */
function jsonSchemaValidator_implementation() {
    //#region jsonSchemaValidator_implementation
    class MyValidatorProvider implements jsonSchemaValidator {
        getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
            // Compile/cache validator from schema
            return (input: unknown) =>
                isValid(schema, input)
                    ? { valid: true, data: input as T, errorMessage: undefined }
                    : { valid: false, data: undefined, errorMessage: 'Error details' };
        }
    }
    //#endregion jsonSchemaValidator_implementation
    return MyValidatorProvider;
}
