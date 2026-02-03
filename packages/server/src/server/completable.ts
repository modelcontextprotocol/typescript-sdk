import type { StandardJSONSchemaV1 } from '@modelcontextprotocol/core';

export const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

export type CompleteCallback<T extends StandardJSONSchemaV1 = StandardJSONSchemaV1> = (
    value: StandardJSONSchemaV1.InferInput<T>,
    context?: {
        arguments?: Record<string, string>;
    }
) => StandardJSONSchemaV1.InferInput<T>[] | Promise<StandardJSONSchemaV1.InferInput<T>[]>;

export type CompletableMeta<T extends StandardJSONSchemaV1 = StandardJSONSchemaV1> = {
    complete: CompleteCallback<T>;
};

export type CompletableSchema<T extends StandardJSONSchemaV1> = T & {
    [COMPLETABLE_SYMBOL]: CompletableMeta<T>;
};

/**
 * Wraps a schema to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 */
export function completable<T extends StandardJSONSchemaV1>(
    schema: T,
    complete: CompleteCallback<T>
): CompletableSchema<T> {
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
export function isCompletable(schema: unknown): schema is CompletableSchema<StandardJSONSchemaV1> {
    return !!schema && typeof schema === 'object' && COMPLETABLE_SYMBOL in (schema as object);
}

/**
 * Gets the completer callback from a completable schema, if it exists.
 */
export function getCompleter<T extends StandardJSONSchemaV1>(schema: T): CompleteCallback<T> | undefined {
    const meta = (schema as unknown as { [COMPLETABLE_SYMBOL]?: CompletableMeta<T> })[COMPLETABLE_SYMBOL];
    return meta?.complete as CompleteCallback<T> | undefined;
}
