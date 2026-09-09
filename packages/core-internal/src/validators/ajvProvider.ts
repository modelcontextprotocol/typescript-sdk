/**
 * AJV-based JSON Schema validator provider
 */

import { Ajv as Draft7Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';

import { declaredDialect } from './dialects';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './types';

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

/** `ajv-formats` default export, normalised through the CJS/ESM interop wrapper. */
const addFormats = _addFormats as unknown as typeof _addFormats.default;

function createDefaultAjvInstance(engineClass: typeof Ajv2020 | typeof Ajv2019 | typeof Draft7Ajv): AjvLike {
    const ajv = new engineClass({
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
 * Default dispatches on the schema's declared dialect: no `$schema` or 2020-12 → `Ajv2020`
 * (SEP-1613); 2019-09 → `Ajv2019`; draft-07 or draft-06 → the classic draft-07 `Ajv` class
 * (draft-07's changes over draft-06 are additive, so one engine covers both). Known draft-07 deviation: classic Ajv
 * evaluates keywords adjacent to `$ref` (stricter than draft-07's ignore-siblings rule, matching
 * v1's default engine), while the cfworker provider ignores them per spec.
 * Schemas declaring any other `$schema` are
 * rejected with a plain `Error`; pass a pre-configured Ajv instance to validate
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
    private _ajv: AjvLike | undefined;
    /** Lazy classic (draft-07) engine, built on the first draft-07/draft-06-declared schema. */
    private _ajvDraft7: AjvLike | undefined;
    /** Lazy 2019-09 engine, built on the first 2019-09-declared schema. */
    private _ajv2019: AjvLike | undefined;
    /** True iff the constructor received a caller-supplied engine; the `$schema` dispatch is skipped. */
    private readonly _userAjv: boolean;

    /**
     * @param ajv - Optional pre-configured AJV-compatible instance. When supplied, this instance is
     * used for **every** schema regardless of its declared `$schema` (the caller owns dialect
     * choice). When omitted, the provider constructs per-dialect engines (`Ajv2020`, `Ajv2019`,
     * and the classic draft-07 `Ajv` for draft-07/06-declared schemas) with
     * `strict: false`, `validateFormats: true`, `validateSchema: false`, `allErrors: true`, and
     * `ajv-formats` registered — **lazily, on the first {@linkcode getValidator} call needing each**, so
     * constructing the provider (e.g. as the default validator of a `Client`/`Server` that never
     * validates a JSON Schema) does not pay the ajv + ajv-formats instantiation cost. The parameter
     * is typed structurally so consumers who don't pass an instance need not have `ajv` installed.
     */
    constructor(ajv?: AjvLike) {
        this._userAjv = ajv !== undefined;
        this._ajv = ajv;
    }

    /** The underlying 2020-12 engine — the default instance is created on first use. */
    private get ajv(): AjvLike {
        return (this._ajv ??= createDefaultAjvInstance(Ajv2020));
    }

    /**
     * Pick the engine for a schema's declared dialect. A caller-supplied engine is used for
     * every schema — do not second-guess by `$schema` (bring-your-own-validator means
     * bring-your-own-dialect). Otherwise: no `$schema` or 2020-12 → `Ajv2020`; 2019-09 →
     * `Ajv2019`; draft-07 or draft-06 → classic `Ajv`; anything else → `Error`.
     */
    private _engineFor(schema: JsonSchemaType): AjvLike {
        if (this._userAjv) {
            return this.ajv;
        }
        const dialect = declaredDialect(
            schema,
            'pass a pre-configured Ajv instance to AjvJsonSchemaValidator(ajv) to validate other dialects.'
        );
        if (dialect === '2020-12') {
            return this.ajv;
        }
        if (dialect === '2019-09') {
            return (this._ajv2019 ??= createDefaultAjvInstance(Ajv2019));
        }
        return (this._ajvDraft7 ??= createDefaultAjvInstance(Draft7Ajv));
    }

    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        const engine = this._engineFor(schema);
        const ajvValidator =
            '$id' in schema && typeof schema.$id === 'string'
                ? (engine.getSchema(schema.$id) ?? engine.compile(schema))
                : engine.compile(schema);

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
                      errorMessage: engine.errorsText(ajvValidator.errors)
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
const Ajv = Draft7Ajv;

export { addFormats, Ajv };
