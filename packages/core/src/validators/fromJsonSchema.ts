import type { StandardSchemaV1, StandardSchemaWithJSON } from '../util/standardSchema.js';
import type { JsonSchemaType, jsonSchemaValidator } from './types.js';

/**
 * Wrap a raw JSON Schema object as a {@linkcode StandardSchemaWithJSON} so it can be
 * passed to `registerTool` / `registerPrompt`. Use this when you already have JSON
 * Schema (e.g. from TypeBox, or hand-written) and want to register it without going
 * through a Standard Schema library.
 *
 * The callback arguments will be typed `unknown` (raw JSON Schema has no TypeScript
 * types attached). Cast at the call site, or use the generic `fromJsonSchema<MyType>(...)`.
 *
 * @param schema - A JSON Schema object describing the expected shape
 * @param validator - A validator provider. When importing `fromJsonSchema` from
 *   `@modelcontextprotocol/server` or `@modelcontextprotocol/client`, a runtime-appropriate
 *   default is provided automatically (AJV on Node.js, CfWorker on edge runtimes).
 *
 * @example
 * ```ts source="./fromJsonSchema.examples.ts#fromJsonSchema_basicUsage"
 * const inputSchema = fromJsonSchema<{ name: string }>(
 *     { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *     new AjvJsonSchemaValidator()
 * );
 * // Use with server.registerTool('greet', { inputSchema }, handler)
 * ```
 */
export function fromJsonSchema<T = unknown>(schema: JsonSchemaType, validator: jsonSchemaValidator): StandardSchemaWithJSON<T, T> {
    const check = validator.getValidator<T>(schema);
    return {
        '~standard': {
            version: 1,
            vendor: 'mcp',
            jsonSchema: {
                input: () => schema as Record<string, unknown>,
                output: () => schema as Record<string, unknown>
            },
            validate: (data: unknown): StandardSchemaV1.Result<T> => {
                const result = check(data);
                return result.valid ? { value: result.data } : { issues: [{ message: result.errorMessage }] };
            }
        }
    };
}
