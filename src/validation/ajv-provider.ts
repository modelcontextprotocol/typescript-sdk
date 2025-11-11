/**
 * AJV-based JSON Schema validator provider
 */

import { Ajv } from 'ajv';
import _addFormats from 'ajv-formats';
import type { JsonSchemaType, JsonSchemaValidator, JsonSchemaValidatorResult, jsonSchemaValidator } from './types.js';

function createDefaultAjvInstance(): Ajv {
    const ajv = new Ajv({
        strict: false,
        validateFormats: true,
        validateSchema: false,
        allErrors: true
    });

    const addFormats = _addFormats as unknown as typeof _addFormats.default;
    addFormats(ajv);

    return ajv;
}

/**
 * @example
 * ```typescript
 * // Use with default AJV instance (recommended)
 * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
 * const validator = new AjvJsonSchemaValidator();
 *
 * // Use with custom AJV instance
 * import { Ajv } from 'ajv';
 * const ajv = new Ajv({ strict: true, allErrors: true });
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 */
export class AjvJsonSchemaValidator implements jsonSchemaValidator {
    private _ajv: Ajv;

    /**
     * Create an AJV validator
     *
     * @param ajv - Optional pre-configured AJV instance. If not provided, a default instance will be created.
     *
     * @example
     * ```typescript
     * // Use default configuration (recommended for most cases)
     * import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
     * const validator = new AjvJsonSchemaValidator();
     *
     * // Or provide custom AJV instance for advanced configuration
     * import { Ajv } from 'ajv';
     * import addFormats from 'ajv-formats';
     *
     * const ajv = new Ajv({ validateFormats: true });
     * addFormats(ajv);
     * const validator = new AjvJsonSchemaValidator(ajv);
     * ```
     */
    constructor(ajv?: Ajv) {
        this._ajv = ajv ?? createDefaultAjvInstance();
    }

    /**
     * Create a validator for the given JSON Schema
     *
     * The validator is compiled once and can be reused multiple times.
     * If the schema has an $id, it will be cached by AJV automatically.
     *
     * @param schema - Standard JSON Schema object
     * @returns A validator function that validates input data
     */
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        // Check if schema has $id and is already compiled/cached
        const ajvValidator =
            '$id' in schema && typeof schema.$id === 'string'
                ? (this._ajv.getSchema(schema.$id) ?? this._ajv.compile(schema))
                : this._ajv.compile(schema);

        return (input: unknown): JsonSchemaValidatorResult<T> => {
            const valid = ajvValidator(input);

            if (valid) {
                return {
                    valid: true,
                    data: input as T,
                    errorMessage: undefined
                };
            } else {
                return {
                    valid: false,
                    data: undefined,
                    errorMessage: this._ajv.errorsText(ajvValidator.errors)
                };
            }
        };
    }
}
