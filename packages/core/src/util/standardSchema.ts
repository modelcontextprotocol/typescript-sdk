/**
 * Standard Schema utilities for user-provided schemas.
 * Supports Zod v4, Valibot, ArkType, and other Standard Schema implementations.
 * @see https://standardschema.dev
 */

/* eslint-disable @typescript-eslint/no-namespace */

import type { JsonSchemaType, jsonSchemaValidator } from '../validation/types.js';

// Standard Schema interfaces (from https://standardschema.dev)

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

/** Combined interface for schemas with both validation and JSON Schema conversion (e.g., Zod v4). */
export interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output> & StandardJSONSchemaV1.Props<Input, Output>;
}

// Type guards

export function isStandardJSONSchema(schema: unknown): schema is StandardJSONSchemaV1 {
    if (schema == null) return false;
    const schemaType = typeof schema;
    if (schemaType !== 'object' && schemaType !== 'function') return false;
    if (!('~standard' in (schema as object))) return false;
    const std = (schema as StandardJSONSchemaV1)['~standard'];
    return typeof std?.jsonSchema?.input === 'function' && typeof std?.jsonSchema?.output === 'function';
}

export function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
    if (schema == null) return false;
    const schemaType = typeof schema;
    if (schemaType !== 'object' && schemaType !== 'function') return false;
    if (!('~standard' in (schema as object))) return false;
    const std = (schema as StandardSchemaV1)['~standard'];
    return typeof std?.validate === 'function';
}

export function isStandardSchemaWithJSON(schema: unknown): schema is StandardSchemaWithJSON {
    return isStandardJSONSchema(schema) && isStandardSchema(schema);
}

// JSON Schema conversion

export function standardSchemaToJsonSchema(schema: StandardJSONSchemaV1, io: 'input' | 'output' = 'input'): Record<string, unknown> {
    return schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
}

// Validation

export type StandardSchemaValidationResult<T> = { success: true; data: T } | { success: false; error: string };

export async function validateStandardSchema<T extends StandardJSONSchemaV1>(
    schema: T,
    data: unknown,
    jsonSchemaValidatorInstance?: jsonSchemaValidator
): Promise<StandardSchemaValidationResult<StandardJSONSchemaV1.InferOutput<T>>> {
    // Use native validation if available
    if (isStandardSchema(schema)) {
        const result = await schema['~standard'].validate(data);
        if (result.issues && result.issues.length > 0) {
            const errorMessage = result.issues.map((i: StandardSchemaV1.Issue) => i.message).join(', ');
            return { success: false, error: errorMessage };
        }
        return { success: true, data: (result as StandardSchemaV1.SuccessResult<unknown>).value as StandardJSONSchemaV1.InferOutput<T> };
    }

    // Fall back to JSON Schema validation
    if (jsonSchemaValidatorInstance) {
        const jsonSchema = standardSchemaToJsonSchema(schema, 'input');
        const validator = jsonSchemaValidatorInstance.getValidator<StandardJSONSchemaV1.InferOutput<T>>(jsonSchema as JsonSchemaType);
        const validationResult = validator(data);

        if (validationResult.valid) {
            return { success: true, data: validationResult.data };
        }
        return { success: false, error: validationResult.errorMessage ?? 'Validation failed' };
    }

    // No validation - trust the data
    return { success: true, data: data as StandardJSONSchemaV1.InferOutput<T> };
}

// Prompt argument extraction

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
