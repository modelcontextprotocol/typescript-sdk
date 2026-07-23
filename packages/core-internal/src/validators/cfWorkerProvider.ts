/**
 * Cloudflare Worker-compatible JSON Schema validator provider
 *
 * This provider uses @cfworker/json-schema for validation without code generation,
 * making it compatible with edge runtimes like Cloudflare Workers that restrict
 * eval and new Function.
 *
 * @see {@linkcode AjvJsonSchemaValidator} for the Node.js alternative
 */

import { Validator } from '@cfworker/json-schema';

import { declaredDialect } from './dialects';
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator, JsonSchemaValidatorResult } from './types';

/**
 * JSON Schema draft version supported by `@cfworker/json-schema`.
 */
export type CfWorkerSchemaDraft = '4' | '7' | '2019-09' | '2020-12';

/**
 * `@cfworker/json-schema`-backed JSON Schema validator. See
 * `@modelcontextprotocol/{client,server}/validators/cf-worker` for the customisation entry point.
 *
 * Default dispatches on the schema's declared dialect: no `$schema` or 2020-12 → `'2020-12'`
 * (SEP-1613); 2019-09 → `'2019-09'`; draft-07 or draft-06 → `'7'`. Schemas declaring any other `$schema` are rejected
 * with a plain `Error`. Passing an explicit `draft` to the constructor
 * overrides this — that draft is used for every schema regardless of `$schema`.
 *
 * @example Use with default configuration (2020-12, shortcircuit on)
 * ```ts source="./cfWorkerProvider.examples.ts#CfWorkerJsonSchemaValidator_default"
 * const validator = new CfWorkerJsonSchemaValidator();
 * ```
 *
 * @example Use with custom configuration
 * ```ts source="./cfWorkerProvider.examples.ts#CfWorkerJsonSchemaValidator_customConfig"
 * const validator = new CfWorkerJsonSchemaValidator({
 *     draft: '2020-12',
 *     shortcircuit: false // Report all errors
 * });
 * ```
 */
export class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
    private readonly shortcircuit: boolean;
    /** Caller-supplied draft; when set, the `$schema` check is skipped (caller owns dialect). */
    private readonly draft?: CfWorkerSchemaDraft;

    /**
     * Create a validator
     *
     * @param options - Configuration options
     * @param options.shortcircuit - If `true`, stop validation after first error (default: `true`)
     * @param options.draft - JSON Schema draft version to force for every schema. When set, the
     * `$schema` dispatch is skipped. When omitted, the provider dispatches on each schema's
     * declared `$schema` (2020-12, 2019-09, draft-07, draft-06; absent means 2020-12) and rejects others.
     */
    constructor(options?: { shortcircuit?: boolean; draft?: CfWorkerSchemaDraft }) {
        this.shortcircuit = options?.shortcircuit ?? true;
        this.draft = options?.draft;
    }

    /**
     * Pick the engine draft for a schema's declared dialect (a caller-forced `{draft}` bypasses
     * this — do not second-guess by `$schema`). No `$schema` or 2020-12 → `'2020-12'`; 2019-09 →
     * `'2019-09'`; draft-07 or draft-06 → `'7'`; anything else → `Error`.
     */
    private _draftFor(schema: JsonSchemaType): CfWorkerSchemaDraft {
        const dialect = declaredDialect(schema, 'pass an explicit { draft } to CfWorkerJsonSchemaValidator to validate other dialects.');
        return dialect === 'draft-7' ? '7' : dialect;
    }

    /**
     * Create a validator for the given JSON Schema
     *
     * Unlike AJV, this validator is not cached internally
     *
     * @param schema - Standard JSON Schema object
     * @returns A validator function that validates input data
     */
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
        const draft = this.draft ?? this._draftFor(schema);
        // Cast to the cfworker Schema type - our JsonSchemaType is structurally compatible
        const validator = new Validator(schema as ConstructorParameters<typeof Validator>[0], draft, this.shortcircuit);

        return (input: unknown): JsonSchemaValidatorResult<T> => {
            const result = validator.validate(input);

            return result.valid
                ? {
                      valid: true,
                      data: input as T,
                      errorMessage: undefined
                  }
                : {
                      valid: false,
                      data: undefined,
                      errorMessage: result.errors.map(err => `${err.instanceLocation}: ${err.error}`).join('; ')
                  };
        };
    }
}
