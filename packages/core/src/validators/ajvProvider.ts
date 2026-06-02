/**
 * AJV-based JSON Schema validator provider
 */

import { Ajv } from 'ajv';
import _addFormats from 'ajv-formats';

import { assertSchemaSafeToCompile } from './schemaBounds.js';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './types.js';

/** Structural subset of the AJV interface used by {@link AjvJsonSchemaValidator}. */
interface AjvLike {
    compile: (schema: unknown) => AjvValidateFunction;
    getSchema: (keyRef: string) => AjvValidateFunction | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errorsText: (errors?: any) => string;
}

interface AjvValidateFunction {
    (input: unknown): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errors?: any;
}

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
 * AJV-backed JSON Schema validator. See `@modelcontextprotocol/{client,server}/validators/ajv`
 * for the customisation entry point (re-exports `Ajv` and `addFormats` from the bundled copy).
 *
 * @example Use with default configuration
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_default"
 * const validator = new AjvJsonSchemaValidator();
 * ```
 *
 * @example Use with a custom AJV instance
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_customInstance"
 * const ajv = new Ajv({ strict: true, allErrors: true });
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 *
 * @example Register ajv-formats
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_withFormats"
 * const ajv = new Ajv({ strict: true, allErrors: true });
 * addFormats(ajv);
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 */
export class AjvJsonSchemaValidator implements jsonSchemaValidator {
    private _ajv: AjvLike;

    /**
     * @param ajv - Optional pre-configured AJV-compatible instance. If omitted, a default instance is
     * created with `strict: false`, `validateFormats: true`, `validateSchema: false`, `allErrors: true`,
     * and `ajv-formats` registered. The parameter is typed structurally so consumers who don't pass
     * an instance need not have `ajv` installed.
     */
    constructor(ajv?: AjvLike) {
        this._ajv = ajv ?? createDefaultAjvInstance();
    }

    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        // SEP-2106: reject non-local $refs (SSRF) and over-budget schemas (composition DoS) before compiling.
        assertSchemaSafeToCompile(schema);

        const ajvValidator =
            '$id' in schema && typeof schema.$id === 'string'
                ? (this._ajv.getSchema(schema.$id) ?? this._ajv.compile(schema))
                : this._ajv.compile(schema);

        return (input: unknown): JsonSchemaValidatorResult<T> => {
            const valid = ajvValidator(input);

            return valid
                ? {
                      valid: true,
                      data: input as T,
                      errorMessage: undefined
                  }
                : {
                      valid: false,
                      data: undefined,
                      errorMessage: this._ajv.errorsText(ajvValidator.errors)
                  };
        };
    }
}

export { Ajv } from 'ajv';
/** `ajv-formats` default export, normalised through the CJS/ESM interop wrapper. */
export const addFormats = _addFormats as unknown as typeof _addFormats.default;
