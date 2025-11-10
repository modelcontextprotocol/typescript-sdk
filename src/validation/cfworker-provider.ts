/**
 * Cloudflare Worker-compatible JSON Schema validator provider
 *
 * This provider uses @cfworker/json-schema for validation without code generation,
 * making it compatible with edge runtimes like Cloudflare Workers that restrict
 * eval and new Function.
 *
 */

import { type Schema, Validator } from '@cfworker/json-schema';
import type { JsonSchemaType, JsonSchemaValidator, JsonSchemaValidatorResult, jsonSchemaValidator } from './types.js';

/**
 * Apply JSON Schema defaults to the provided data in-place.
 * This performs a best-effort traversal covering common constructs:
 * - type: "object" with "properties"
 * - type: "array" with "items"
 * - allOf / anyOf / oneOf (applies defaults from each sub-schema)
 *
 * It intentionally does not attempt full $ref resolution or advanced constructs,
 * which are not needed for the MCP elicitation top-level schemas.
 */
function applyDefaults(schema: Schema | undefined, data: unknown): void {
    if (!schema || data === null || typeof data !== 'object') return;

    // Handle object properties
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
        const obj = data as Record<string, unknown>;
        const props = schema.properties as Record<string, Schema & { default?: unknown }>;
        for (const key of Object.keys(props)) {
            const propSchema = props[key];
            // If missing or explicitly undefined, apply default if present
            if (obj[key] === undefined && Object.prototype.hasOwnProperty.call(propSchema, 'default')) {
                obj[key] = propSchema.default;
            }
            // Recurse into existing nested objects/arrays
            if (obj[key] !== undefined) {
                applyDefaults(propSchema, obj[key]);
            }
        }
    }

    // Handle arrays
    if (schema.type === 'array' && Array.isArray(data) && schema.items) {
        const itemsSchema = schema.items as Schema | Schema[];
        if (Array.isArray(itemsSchema)) {
            for (let i = 0; i < data.length && i < itemsSchema.length; i++) {
                applyDefaults(itemsSchema[i], data[i]);
            }
        } else {
            for (const item of data) {
                applyDefaults(itemsSchema, item);
            }
        }
    }

    // Combine schemas
    if (Array.isArray(schema.allOf)) {
        for (const sub of schema.allOf) {
            applyDefaults(sub, data);
        }
    }
    if (Array.isArray(schema.anyOf)) {
        for (const sub of schema.anyOf) {
            applyDefaults(sub, data);
        }
    }
    if (Array.isArray(schema.oneOf)) {
        for (const sub of schema.oneOf) {
            applyDefaults(sub, data);
        }
    }
}

/**
 * JSON Schema draft version supported by @cfworker/json-schema
 */
export type CfWorkerSchemaDraft = '4' | '7' | '2019-09' | '2020-12';

/**
 *
 * @example
 * ```typescript
 * // Use with default configuration (2020-12, shortcircuit)
 * const validator = new CfWorkerJsonSchemaValidator();
 *
 * // Use with custom configuration
 * const validator = new CfWorkerJsonSchemaValidator({
 *   draft: '2020-12',
 *   shortcircuit: false // Report all errors
 * });
 * ```
 */
export class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
    private shortcircuit: boolean;
    private draft: CfWorkerSchemaDraft;

    /**
     * Create a validator
     *
     * @param options - Configuration options
     * @param options.shortcircuit - If true, stop validation after first error (default: true)
     * @param options.draft - JSON Schema draft version to use (default: '2020-12')
     */
    constructor(options?: { shortcircuit?: boolean; draft?: CfWorkerSchemaDraft }) {
        this.shortcircuit = options?.shortcircuit ?? true;
        this.draft = options?.draft ?? '2020-12';
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
        const cfSchema = schema as unknown as Schema;
        const validator = new Validator(cfSchema, this.draft, this.shortcircuit);

        return (input: unknown): JsonSchemaValidatorResult<T> => {
            // Mirror AJV's useDefaults behavior by applying defaults before validation.
            try {
                applyDefaults(cfSchema, input);
            } catch {
                // Best-effort only; ignore errors in default application
            }

            const result = validator.validate(input);

            if (result.valid) {
                return {
                    valid: true,
                    data: input as T,
                    errorMessage: undefined
                };
            } else {
                return {
                    valid: false,
                    data: undefined,
                    errorMessage: result.errors.map(err => `${err.instanceLocation}: ${err.error}`).join('; ')
                };
            }
        };
    }
}
