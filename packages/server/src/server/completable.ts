import type { StandardSchemaV1 } from '@modelcontextprotocol/core-internal';

export const COMPLETABLE_SYMBOL: unique symbol = Symbol.for('mcp.completable');

export type CompleteCallback<T extends StandardSchemaV1 = StandardSchemaV1> = (
    value: StandardSchemaV1.InferInput<T>,
    context?: {
        arguments?: Record<string, string>;
    }
) => StandardSchemaV1.InferInput<T>[] | Promise<StandardSchemaV1.InferInput<T>[]>;

export type CompletableMeta<T extends StandardSchemaV1 = StandardSchemaV1> = {
    complete: CompleteCallback<T>;
};

export type CompletableSchema<T extends StandardSchemaV1> = T & {
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
export function completable<T extends StandardSchemaV1>(schema: T, complete: CompleteCallback<T>): CompletableSchema<T> {
    const meta: CompletableMeta<T> = { complete };
    Object.defineProperty(schema as object, COMPLETABLE_SYMBOL, {
        value: meta,
        enumerable: false,
        writable: false,
        configurable: true
    });

    const schemaWithDef = schema as unknown as { def?: unknown; _def?: unknown };
    const def = schemaWithDef.def ?? schemaWithDef._def;
    if (def && typeof def === 'object' && Object.isExtensible(def)) {
        Object.defineProperty(def, COMPLETABLE_SYMBOL, {
            value: meta,
            enumerable: false,
            writable: false,
            configurable: true
        });
    }

    return schema as CompletableSchema<T>;
}

function findCompleterMeta(schema: unknown, visited = new Set<unknown>()): CompletableMeta | undefined {
    if (!schema || typeof schema !== 'object' || visited.has(schema)) {
        return undefined;
    }
    visited.add(schema);

    const directMeta = (schema as { [COMPLETABLE_SYMBOL]?: CompletableMeta })[COMPLETABLE_SYMBOL];
    if (directMeta?.complete) {
        return directMeta;
    }

    const candidate = schema as { def?: unknown; _def?: unknown };
    const def = candidate.def ?? candidate._def;
    if (def && typeof def === 'object') {
        if (!visited.has(def)) {
            visited.add(def);
            const defMeta = (def as { [COMPLETABLE_SYMBOL]?: CompletableMeta })[COMPLETABLE_SYMBOL];
            if (defMeta?.complete) {
                return defMeta;
            }
        }

        const unwrappable = def as { innerType?: unknown; schema?: unknown; in?: unknown };
        if (unwrappable.innerType) {
            const innerMeta = findCompleterMeta(unwrappable.innerType, visited);
            if (innerMeta) return innerMeta;
        }
        if (unwrappable.schema) {
            const innerMeta = findCompleterMeta(unwrappable.schema, visited);
            if (innerMeta) return innerMeta;
        }
        if (unwrappable.in) {
            const innerMeta = findCompleterMeta(unwrappable.in, visited);
            if (innerMeta) return innerMeta;
        }
    }

    return undefined;
}

/**
 * Checks if a schema is completable (has completion metadata).
 */
export function isCompletable(schema: unknown): schema is CompletableSchema<StandardSchemaV1> {
    return !!findCompleterMeta(schema);
}

/**
 * Gets the completer callback from a completable schema, if it exists.
 */
export function getCompleter<T extends StandardSchemaV1>(schema: T): CompleteCallback<T> | undefined {
    return findCompleterMeta(schema)?.complete as CompleteCallback<T> | undefined;
}
