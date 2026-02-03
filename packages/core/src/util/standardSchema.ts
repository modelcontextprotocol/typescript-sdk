/**
 * Standard JSON Schema utilities for user-provided schemas.
 * These types and utilities support any schema library that implements
 * the Standard Schema spec (https://standardschema.dev).
 *
 * Supported libraries include: Zod v4, Valibot, ArkType, and others.
 */

/* eslint-disable @typescript-eslint/no-namespace */
// Namespaces are used here to match the Standard Schema spec interface design,
// enabling ergonomic type inference like `StandardJSONSchemaV1.InferOutput<T>`.

import type { JsonSchemaType, jsonSchemaValidator } from '../validation/types.js';

// ============================================================================
// Standard Schema Interfaces (from https://standardschema.dev)
// ============================================================================
// These interfaces are copied from the Standard Schema spec to avoid adding
// a dependency. They match the @standard-schema/spec package.

/**
 * The base Standard interface for typed schemas.
 * @see https://standardschema.dev
 */
export interface StandardTypedV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardTypedV1.Props<Input, Output>;
}

export namespace StandardTypedV1 {
    export interface Props<Input = unknown, Output = Input> {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: Types<Input, Output> | undefined;
    }

    export interface Types<Input = unknown, Output = Input> {
        readonly input: Input;
        readonly output: Output;
    }

    export type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema['~standard']['types']>['input'];
    export type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema['~standard']['types']>['output'];
}

/**
 * The Standard Schema interface for schemas that support validation.
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
    export interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        readonly validate: (value: unknown, options?: Options | undefined) => Result<Output> | Promise<Result<Output>>;
    }

    export interface Options {
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }

    export type Result<Output> = SuccessResult<Output> | FailureResult;

    export interface SuccessResult<Output> {
        readonly value: Output;
        readonly issues?: undefined;
    }

    export interface FailureResult {
        readonly issues: ReadonlyArray<Issue>;
    }

    export interface Issue {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    }

    export interface PathSegment {
        readonly key: PropertyKey;
    }

    export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

/**
 * The Standard JSON Schema interface for schemas that can be converted to JSON Schema.
 * This is the primary interface for user-provided tool and prompt schemas.
 * @see https://standardschema.dev/json-schema
 */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
}

export namespace StandardJSONSchemaV1 {
    export interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        readonly jsonSchema: Converter;
    }

    export interface Converter {
        readonly input: (options: Options) => Record<string, unknown>;
        readonly output: (options: Options) => Record<string, unknown>;
    }

    export type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | (object & string);

    export interface Options {
        readonly target: Target;
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }

    export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

/**
 * Combined interface for schemas that implement both StandardSchemaV1 and StandardJSONSchemaV1.
 * Zod v4 schemas implement this combined interface.
 */
export interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output> & StandardJSONSchemaV1.Props<Input, Output>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a value implements StandardJSONSchemaV1 (has jsonSchema conversion).
 * This is the primary interface for schemas that can be converted to JSON Schema for the wire protocol.
 * Note: Some libraries (e.g., ArkType) use function-based schemas, so we check for both objects and functions.
 */
export function isStandardJSONSchema(schema: unknown): schema is StandardJSONSchemaV1 {
    if (schema == null) return false;
    const schemaType = typeof schema;
    if (schemaType !== 'object' && schemaType !== 'function') return false;
    if (!('~standard' in (schema as object))) return false;
    const std = (schema as StandardJSONSchemaV1)['~standard'];
    return typeof std?.jsonSchema?.input === 'function' && typeof std?.jsonSchema?.output === 'function';
}

/**
 * Type guard to check if a value implements StandardSchemaV1 (has validate method).
 * Schemas that implement this interface can perform native validation.
 * Note: Some libraries (e.g., ArkType) use function-based schemas, so we check for both objects and functions.
 */
export function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
    if (schema == null) return false;
    const schemaType = typeof schema;
    if (schemaType !== 'object' && schemaType !== 'function') return false;
    if (!('~standard' in (schema as object))) return false;
    const std = (schema as StandardSchemaV1)['~standard'];
    return typeof std?.validate === 'function';
}

/**
 * Type guard to check if a value implements both StandardSchemaV1 and StandardJSONSchemaV1.
 * Zod v4 schemas implement this combined interface.
 */
export function isStandardSchemaWithJSON(schema: unknown): schema is StandardSchemaWithJSON {
    return isStandardJSONSchema(schema) && isStandardSchema(schema);
}

// ============================================================================
// JSON Schema Conversion
// ============================================================================

/**
 * Converts a StandardJSONSchemaV1 to JSON Schema for the wire protocol.
 *
 * @param schema - A schema implementing StandardJSONSchemaV1
 * @param io - Whether to get the 'input' or 'output' JSON Schema (default: 'input')
 * @returns JSON Schema object compatible with Draft 2020-12
 */
export function standardSchemaToJsonSchema(schema: StandardJSONSchemaV1, io: 'input' | 'output' = 'input'): Record<string, unknown> {
    return schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Result type for Standard Schema validation.
 */
export type StandardSchemaValidationResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Validates data against a StandardJSONSchemaV1 schema.
 *
 * If the schema also implements StandardSchemaV1 (has a validate method), uses native validation.
 * Otherwise, falls back to JSON Schema validation using the provided validator.
 *
 * @param schema - A schema implementing StandardJSONSchemaV1
 * @param data - The data to validate
 * @param jsonSchemaValidatorInstance - Optional JSON Schema validator for fallback validation
 * @returns Validation result with typed data on success or error message on failure
 */
export async function validateStandardSchema<T extends StandardJSONSchemaV1>(
    schema: T,
    data: unknown,
    jsonSchemaValidatorInstance?: jsonSchemaValidator
): Promise<StandardSchemaValidationResult<StandardJSONSchemaV1.InferOutput<T>>> {
    // If schema also implements StandardSchemaV1, use native validation
    if (isStandardSchema(schema)) {
        const result = await schema['~standard'].validate(data);
        // Per Standard Schema spec: FailureResult has issues array, SuccessResult has value without issues
        // Some libraries (e.g., Valibot) always include value, so we check issues first
        if (result.issues && result.issues.length > 0) {
            const errorMessage = result.issues.map((i: StandardSchemaV1.Issue) => i.message).join(', ');
            return { success: false, error: errorMessage };
        }
        // At this point we have a SuccessResult which has value
        return { success: true, data: (result as StandardSchemaV1.SuccessResult<unknown>).value as StandardJSONSchemaV1.InferOutput<T> };
    }

    // Fall back to JSON Schema validation if validator provided
    if (jsonSchemaValidatorInstance) {
        const jsonSchema = standardSchemaToJsonSchema(schema, 'input');
        const validator = jsonSchemaValidatorInstance.getValidator<StandardJSONSchemaV1.InferOutput<T>>(jsonSchema as JsonSchemaType);
        const validationResult = validator(data);

        if (validationResult.valid) {
            return { success: true, data: validationResult.data };
        }
        return { success: false, error: validationResult.errorMessage ?? 'Validation failed' };
    }

    // No validation possible - schema doesn't have validate and no fallback validator
    // In this case, we trust the data and return it as-is
    return { success: true, data: data as StandardJSONSchemaV1.InferOutput<T> };
}

// ============================================================================
// Prompt Argument Extraction
// ============================================================================

/**
 * Extracts prompt arguments from a StandardJSONSchemaV1 schema.
 * Uses JSON Schema introspection to determine argument names, descriptions, and required status.
 *
 * @param schema - A schema implementing StandardJSONSchemaV1
 * @returns Array of prompt arguments with name, description, and required status
 */
export function promptArgumentsFromStandardSchema(
    schema: StandardJSONSchemaV1
): Array<{ name: string; description?: string; required: boolean }> {
    const jsonSchema = standardSchemaToJsonSchema(schema, 'input');
    const properties = (jsonSchema.properties as Record<string, { description?: string }>) || {};
    const required = (jsonSchema.required as string[]) || [];

    return Object.entries(properties).map(([name, prop]) => ({
        name,
        description: prop?.description,
        required: required.includes(name)
    }));
}
