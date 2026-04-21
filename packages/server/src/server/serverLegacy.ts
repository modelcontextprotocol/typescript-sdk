import type { CallToolResult, GetPromptResult, ServerContext, StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/core';
import { isStandardSchema, isStandardSchemaWithJSON } from '@modelcontextprotocol/core';
import { z } from 'zod/v4';

/**
 * v1 compat: a "raw shape" is a plain object whose values are Zod schemas
 * (e.g. `{ name: z.string() }`), or an empty object. v1's `tool()`/`prompt()`
 * and `registerTool({inputSchema:{}})` accepted these directly.
 */
export type ZodRawShapeCompat = Record<string, z.core.$ZodType>;

/** v1-style callback signature for the deprecated {@linkcode McpServer.tool | tool()} overloads. */
export type LegacyToolCallback<Args extends ZodRawShapeCompat> = (
    args: z.infer<z.ZodObject<Args>>,
    ctx: ServerContext
) => CallToolResult | Promise<CallToolResult>;

/** v1-style callback signature for the deprecated {@linkcode McpServer.prompt | prompt()} overloads. */
export type LegacyPromptCallback<Args extends ZodRawShapeCompat> = (
    args: z.infer<z.ZodObject<Args>>,
    ctx: ServerContext
) => GetPromptResult | Promise<GetPromptResult>;

/**
 * v1 compat: extract the literal method string from a `z.object({method: z.literal('x'), ...})` schema.
 */
export function extractMethodFromSchema(schema: { shape: { method: unknown } }): string {
    const lit = schema.shape.method as
        | { value?: unknown; def?: { values?: unknown[] }; _zod?: { def?: { values?: unknown[] } } }
        | undefined;
    const v = lit?.value ?? lit?.def?.values?.[0] ?? lit?._zod?.def?.values?.[0];
    if (typeof v !== 'string') {
        throw new TypeError('setRequestHandler(schema, handler): schema.shape.method must be a z.literal(string)');
    }
    return v;
}

function isZodTypeLike(v: unknown): boolean {
    return v != null && typeof v === 'object' && '_zod' in (v as object);
}

export function isZodRawShapeCompat(v: unknown): v is ZodRawShapeCompat {
    if (v == null || typeof v !== 'object') return false;
    if (isStandardSchema(v)) return false;
    const values = Object.values(v as object);
    if (values.length === 0) return true;
    return values.some(v => isZodTypeLike(v));
}

/**
 * Coerce a v1-style raw Zod shape (or empty object) to a {@linkcode StandardSchemaWithJSON}.
 * Standard Schemas pass through unchanged.
 */
export function coerceSchema(schema: unknown): StandardSchemaWithJSON | undefined {
    if (schema == null) return undefined;
    if (isStandardSchemaWithJSON(schema)) return schema;
    if (isZodRawShapeCompat(schema)) return z.object(schema) as unknown as StandardSchemaWithJSON;
    if (isStandardSchema(schema)) {
        throw new Error('Schema lacks JSON-Schema emission (zod >=4.2 or equivalent required).');
    }
    throw new Error('inputSchema/argsSchema must be a Standard Schema or a Zod raw shape (e.g. {name: z.string()})');
}

/**
 * Parse the variadic argument list of the deprecated {@linkcode McpServer.tool | tool()} overloads.
 */
export function parseLegacyToolArgs(
    name: string,
    rest: unknown[]
): { description?: string; inputSchema?: StandardSchemaWithJSON; annotations?: ToolAnnotations; cb: unknown } {
    let description: string | undefined;
    let inputSchema: StandardSchemaWithJSON | undefined;
    let annotations: ToolAnnotations | undefined;
    if (typeof rest[0] === 'string') description = rest.shift() as string;
    if (rest.length > 1) {
        const first = rest[0];
        if (isZodRawShapeCompat(first) || isStandardSchema(first)) {
            inputSchema = coerceSchema(rest.shift());
            if (rest.length > 1 && typeof rest[0] === 'object' && rest[0] !== null && !isZodRawShapeCompat(rest[0])) {
                annotations = rest.shift() as ToolAnnotations;
            }
        } else if (typeof first === 'object' && first !== null) {
            if (Object.values(first).some(v => typeof v === 'object' && v !== null)) {
                throw new Error(`Tool ${name} expected a Zod schema or ToolAnnotations, but received an unrecognized object`);
            }
            annotations = rest.shift() as ToolAnnotations;
        }
    }
    return { description, inputSchema, annotations, cb: rest[0] };
}

/**
 * Parse the variadic argument list of the deprecated {@linkcode McpServer.prompt | prompt()} overloads.
 */
export function parseLegacyPromptArgs(rest: unknown[]): { description?: string; argsSchema?: StandardSchemaWithJSON; cb: unknown } {
    let description: string | undefined;
    if (typeof rest[0] === 'string') description = rest.shift() as string;
    let argsSchema: StandardSchemaWithJSON | undefined;
    if (rest.length > 1) argsSchema = coerceSchema(rest.shift());
    return { description, argsSchema, cb: rest[0] };
}
