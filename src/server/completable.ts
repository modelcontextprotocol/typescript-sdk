// Zod-agnostic "completable" wrapper for v3 and v4
// We attach metadata to any Zod schema (v3 or v4) using a symbol,
// avoiding inheritance from Zod internals (which changed in v4).

import type { AnySchema, SchemaInput } from './zod-compat.js';

export enum McpZodTypeKind {
    // Kept for backwards-compat with any code that imports this enum
    Completable = 'McpCompletable'
}

export type CompleteCallback<T extends AnySchema = AnySchema> = (
    value: SchemaInput<T>,
    context?: {
        arguments?: Record<string, string>;
    }
) => SchemaInput<T>[] | Promise<SchemaInput<T>[]>;

// internal symbol to store completable metadata
export const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

type CompletableMeta<T extends AnySchema> = {
    complete: CompleteCallback<T>;
};

export type CompletableSchema<T extends AnySchema> = T & {
    [COMPLETABLE_SYMBOL]: CompletableMeta<T>;
};

/**
 * Wraps a Zod schema (v3 or v4) with autocompletion capability by attaching
 * a non-enumerable symbol-based metadata field. No subclassing; parsing behavior
 * remains entirely delegated to the underlying schema.
 */
export function completable<T extends AnySchema>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T> {
    // Define as non-enumerable, non-configurable metadata
    Object.defineProperty(schema as object, COMPLETABLE_SYMBOL, {
        value: { complete } as CompletableMeta<T>,
        enumerable: false,
        writable: false,
        configurable: false
    });
    return schema as CompletableSchema<T>;
}

/** Type guard: is this schema completable? */
export function isCompletable(schema: unknown): schema is CompletableSchema<AnySchema> {
    return !!schema && typeof schema === 'object' && COMPLETABLE_SYMBOL in (schema as object);
}

/** Retrieve the completer callback, if present. */
export function getCompleter<T extends AnySchema>(schema: T): CompleteCallback<T> | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (schema as any)[COMPLETABLE_SYMBOL] as CompletableMeta<T> | undefined;
    return meta?.complete as CompleteCallback<T> | undefined;
}

/**
 * Backwards-compat "unwrap": previously a class returned `.unwrap()`.
 * Now it's a no-op helper that simply returns the input schema.
 */
export function unwrapCompletable<T extends AnySchema>(schema: T): T {
    return schema;
}
