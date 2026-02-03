import type { AnySchema, SchemaInput } from '@modelcontextprotocol/core';

export const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

export type CompleteCallback<T extends AnySchema = AnySchema> = (
    value: SchemaInput<T>,
    context?: {
        arguments?: Record<string, string>;
    }
) => SchemaInput<T>[] | Promise<SchemaInput<T>[]>;

export type CompletableMeta<T extends AnySchema = AnySchema> = {
    complete: CompleteCallback<T>;
};

export type CompletableSchema<T extends AnySchema> = T & {
    [COMPLETABLE_SYMBOL]: CompletableMeta<T>;
};

/**
 * Wraps a Zod type to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 * Works with both Zod v3 and v4 schemas.
 */
export function completable<T extends AnySchema>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T> {
    Object.defineProperty(schema as object, COMPLETABLE_SYMBOL, {
        value: { complete } as CompletableMeta<T>,
        enumerable: false,
        writable: false,
        configurable: false
    });
    return schema as CompletableSchema<T>;
}

/**
 * Checks if a schema is completable (has completion metadata).
 */
export function isCompletable(schema: unknown): schema is CompletableSchema<AnySchema> {
    return !!schema && typeof schema === 'object' && COMPLETABLE_SYMBOL in (schema as object);
}

/**
 * Gets the completer callback from a completable schema, if it exists.
 */
export function getCompleter<T extends AnySchema>(schema: T): CompleteCallback<T> | undefined {
    const meta = (schema as unknown as { [COMPLETABLE_SYMBOL]?: CompletableMeta<T> })[COMPLETABLE_SYMBOL];
    return meta?.complete as CompleteCallback<T> | undefined;
}

/**
 * Unwraps a completable schema to get the underlying schema.
 * For backward compatibility with code that called `.unwrap()`.
 */
export function unwrapCompletable<T extends AnySchema>(schema: CompletableSchema<T>): T {
    return schema;
}

// Legacy exports for backward compatibility
// These types are deprecated but kept for existing code
export enum McpZodTypeKind {
    Completable = 'McpCompletable'
}

export interface CompletableDef<T extends AnySchema = AnySchema> {
    type: T;
    complete: CompleteCallback<T>;
    typeName: McpZodTypeKind.Completable;
}
