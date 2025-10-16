import { ZodTypeAny } from 'zod';

export enum McpZodTypeKind {
    Completable = 'McpCompletable'
}

export type CompleteCallback<T extends ZodTypeAny = ZodTypeAny> = (
    value: T['_input'],
    context?: {
        arguments?: Record<string, string>;
    }
) => T['_input'][] | Promise<T['_input'][]>;

export interface CompletableDef<T extends ZodTypeAny = ZodTypeAny> {
    type: T;
    complete: CompleteCallback<T>;
    typeName: McpZodTypeKind.Completable;
}

/**
 * A Zod schema that has been wrapped with completion capabilities.
 */
export type CompletableSchema<T extends ZodTypeAny> = T & { _def: T['_def'] & CompletableDef<T> };

/**
 * Wraps a Zod type to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 *
 * Uses an immutable wrapper approach that creates a new schema object with completion metadata
 * while preserving all validation behavior of the underlying schema.
 */
export function completable<T extends ZodTypeAny>(
    schema: T,
    complete: CompleteCallback<T>
): CompletableSchema<T> {
    // Create new schema object inheriting from original
    const wrapped = Object.create(Object.getPrototypeOf(schema));

    // Copy all properties including getters/setters (except _def and _zod which we'll redefine)
    Object.getOwnPropertyNames(schema).forEach(key => {
        if (key !== '_def' && key !== '_zod') {
            const descriptor = Object.getOwnPropertyDescriptor(schema, key);
            if (descriptor) {
                Object.defineProperty(wrapped, key, descriptor);
            }
        }
    });

    // Create new def with added completion metadata
    const newDef = {
        ...schema._def,
        typeName: McpZodTypeKind.Completable,
        type: schema,
        complete
    };

    // Set _def as read-only property (matching Zod's design)
    Object.defineProperty(wrapped, '_def', {
        value: newDef,
        writable: false,
        enumerable: false,
        configurable: false
    });

    // Update _zod to maintain _def === _zod.def invariant
    wrapped._zod = {
        ...schema._zod,
        def: newDef
    };

    return wrapped as CompletableSchema<T>;
}
