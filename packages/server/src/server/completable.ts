import type { AnySchema } from '@modelcontextprotocol/core';
import type * as z from 'zod/v4';

export const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

export type CompleteCallback<T extends AnySchema = AnySchema> = (
    value: z.input<T>,
    context?: {
        arguments?: Record<string, string>;
    }
) => z.input<T>[] | Promise<z.input<T>[]>;

export type CompletableMeta<T extends AnySchema = AnySchema> = {
    complete: CompleteCallback<T>;
};

export type CompletableSchema<T extends AnySchema> = T & {
    [COMPLETABLE_SYMBOL]: CompletableMeta<T>;
};

/**
 * Wraps a Zod type to provide autocompletion capabilities. Useful for, e.g., prompt arguments in MCP.
 *
 * @see {@linkcode server/mcp.McpServer.registerPrompt | McpServer.registerPrompt} for using completable schemas in prompt argument definitions
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
