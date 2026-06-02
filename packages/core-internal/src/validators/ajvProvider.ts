/**
 * AJV-based JSON Schema validator provider
 */

import { Ajv2020 } from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';

import { assertSchemaSafeToCompile } from './schemaBounds';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './types';

/**
 * Canonical 2020-12 `$schema` URIs (http + https variants, trailing-`#` stripped). When a schema
 * declares anything else, the default provider throws a plain `Error` with a clear message rather
 * than letting the engine crash on an opaque internal error or silently mis-validate.
 */
const DRAFT_2020_12_URIS: ReadonlySet<string> = new Set([
    'https://json-schema.org/draft/2020-12/schema',
    'http://json-schema.org/draft/2020-12/schema'
]);

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

const addFormats = _addFormats as unknown as typeof _addFormats.default;

function createDefaultAjvInstance(): AjvLike {
    const ajv = new Ajv2020({
        strict: false,
        validateFormats: true,
        validateSchema: false,
        allErrors: true
    });
    addFormats(ajv);
    return ajv;
}

/**
 * AJV-backed JSON Schema validator. See `@modelcontextprotocol/{client,server}/validators/ajv`
 * for the customisation entry point (re-exports `Ajv` and `addFormats` from the bundled copy).
 *
 * Default validates as **JSON Schema 2020-12** (SEP-1613). Schemas declaring a different
 * `$schema` are rejected with a plain `Error`; pass a pre-configured Ajv instance to validate
 * other dialects. The SDK bundles ajv internally but does not re-export `Ajv2020` (its type
 * graph tips downstream declaration bundling — see #2339). To construct a custom 2020-12
 * instance, add `ajv` to your own dependencies (matching the SDK's pinned version) and
 * `import { Ajv2020 } from 'ajv/dist/2020.js'` — `new Ajv(...)` is the draft-07 class and would
 * silently downgrade dialect.
 *
 * @example Use with default configuration
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_default"
 * const validator = new AjvJsonSchemaValidator();
 * ```
 *
 * @example Use with a custom AJV instance
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_customInstance"
 * // import { Ajv2020 } from 'ajv/dist/2020.js';
 * const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true });
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 *
 * @example Register ajv-formats
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_withFormats"
 * // import { Ajv2020 } from 'ajv/dist/2020.js';
 * const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: true });
 * addFormats(ajv);
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 */
export class AjvJsonSchemaValidator implements jsonSchemaValidator {
    private readonly _ajv: AjvLike;
    /** True iff the constructor received a caller-supplied engine; the `$schema` check is skipped. */
    private readonly _userAjv: boolean;

    /**
     * @param ajv - Optional pre-configured AJV-compatible instance. When supplied, this instance is
     * used for **every** schema regardless of its declared `$schema` (the caller owns dialect
     * choice). When omitted, the provider constructs a single `Ajv2020` instance with
     * `strict: false`, `validateFormats: true`, `validateSchema: false`, `allErrors: true`, and
     * `ajv-formats` registered. The parameter is typed structurally so consumers who don't pass an
     * instance need not have `ajv` installed.
     */
    constructor(ajv?: AjvLike) {
        this._userAjv = ajv !== undefined;
        this._ajv = ajv ?? createDefaultAjvInstance();
    }

    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        // Caller supplied a specific engine — do not second-guess by `$schema`
        // (bring-your-own-validator means bring-your-own-dialect).
        if (
            !this._userAjv &&
            '$schema' in schema &&
            typeof schema.$schema === 'string' &&
            !DRAFT_2020_12_URIS.has(schema.$schema.replace(/#$/, ''))
        ) {
            const declared = schema.$schema.slice(0, 200);
            throw new Error(
                `JSON Schema declares an unsupported dialect ("$schema": "${declared}"). ` +
                    `The default validator supports JSON Schema 2020-12 only; pass a pre-configured ` +
                    `Ajv instance to AjvJsonSchemaValidator(ajv) to validate other dialects.`
            );
        }

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

/**
 * Draft-07 AJV class, re-exported for consumers who need to opt back to the pre-SEP-1613 default.
 * The full v1-equivalent construction is:
 *
 * ```ts
 * const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
 * addFormats(ajv);
 * new AjvJsonSchemaValidator(ajv);
 * ```
 *
 * (omitting `validateSchema: false` makes a 2020-12-stamped `$schema` fail with an opaque
 * "no schema with key or ref …" engine error; omitting `addFormats` silently drops `format`
 * validation that the v1 default had).
 *
 * The SDK bundles ajv internally but does not re-export `Ajv2020` (its type graph tips downstream
 * declaration bundling — see #2339). To construct a custom 2020-12 instance, add `ajv` to your own
 * dependencies (matching the SDK's pinned version) and `import { Ajv2020 } from 'ajv/dist/2020.js'`.
 */
export { Ajv } from 'ajv';
/** `ajv-formats` default export, normalised through the CJS/ESM interop wrapper. */
export { addFormats };
