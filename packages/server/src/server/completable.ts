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
 *
 * @example
 * ```ts source="./completable.examples.ts#completable_basicUsage"
 * server.registerPrompt(
 *     'review-code',
 *     {
 *         title: 'Code Review',
 *         argsSchema: z.object({
 *             language: completable(z.string().describe('Programming language'), value =>
 *                 ['typescript', 'javascript', 'python', 'rust', 'go'].filter(lang => lang.startsWith(value))
 *             )
 *         })
 *     },
 *     ({ language }) => ({
 *         messages: [
 *             {
 *                 role: 'user' as const,
 *                 content: {
 *                     type: 'text' as const,
 *                     text: `Review this ${language} code.`
 *                 }
 *             }
 *         ]
 *     })
 * );
 * ```
 *
 * @see {@linkcode server/mcp.McpServer.registerPrompt | McpServer.registerPrompt} for using completable schemas in prompt argument definitions
 */
export function completable<T extends StandardJSONSchemaV1>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T> {
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
