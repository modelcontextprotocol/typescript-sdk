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
    if (v == null || typeof v !== 'object') return false;
    return '_zod' in (v as object) || '_def' in (v as object);
}

function isZodV4Type(v: unknown): boolean {
    return v != null && typeof v === 'object' && '_zod' in (v as object);
}

export function isZodRawShapeCompat(v: unknown): v is ZodRawShapeCompat {
    if (v == null || typeof v !== 'object') return false;
    if (isStandardSchema(v)) return false;
    const values = Object.values(v as object);
    if (values.length === 0) return true;
    return values.some(v => isZodTypeLike(v));
}

type ZodV3Like = {
    _def: { typeName?: string; innerType?: ZodV3Like; type?: ZodV3Like; shape?: () => Record<string, ZodV3Like>; values?: unknown[] };
    description?: string;
    isOptional?: () => boolean;
    '~standard'?: { validate: (v: unknown) => unknown };
};

/** Best-effort JSON Schema synthesis for a single zod v3 schema (covers common primitives). */
function v3ToJsonSchema(s: ZodV3Like): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (s.description) out.description = s.description;
    const tn = s._def?.typeName;
    switch (tn) {
        case 'ZodString': {
            out.type = 'string';
            break;
        }
        case 'ZodNumber': {
            out.type = 'number';
            break;
        }
        case 'ZodBoolean': {
            out.type = 'boolean';
            break;
        }
        case 'ZodArray': {
            out.type = 'array';
            if (s._def.type) out.items = v3ToJsonSchema(s._def.type);
            break;
        }
        case 'ZodEnum':
        case 'ZodNativeEnum': {
            if (Array.isArray(s._def.values)) out.enum = s._def.values;
            break;
        }
        case 'ZodObject': {
            const shape = s._def.shape?.();
            out.type = 'object';
            if (shape) {
                const entries = Object.entries(shape);
                out.properties = Object.fromEntries(entries.map(([k, v]) => [k, v3ToJsonSchema(v)]));
                out.required = entries.filter(([, v]) => !v.isOptional?.()).map(([k]) => k);
            }
            break;
        }
        case 'ZodOptional':
        case 'ZodNullable':
        case 'ZodDefault': {
            return s._def.innerType ? { ...v3ToJsonSchema(s._def.innerType), ...out } : out;
        }
        default: {
            break;
        }
    }
    return out;
}

/** Wrap a raw shape whose values are zod v3 (or any Standard Schema lacking jsonSchema) into a {@linkcode StandardSchemaWithJSON}. */
function adaptRawShapeToStandard(shape: Record<string, ZodV3Like>): StandardSchemaWithJSON {
    const entries = Object.entries(shape);
    const required = entries.filter(([, v]) => !v.isOptional?.()).map(([k]) => k);
    const jsonSchema = {
        type: 'object',
        properties: Object.fromEntries(entries.map(([k, v]) => [k, v3ToJsonSchema(v)])),
        required,
        additionalProperties: false
    };
    const emit = () => jsonSchema;
    return {
        '~standard': {
            version: 1,
            vendor: 'mcp-zod-v3-compat',
            validate: input => {
                if (typeof input !== 'object' || input === null) {
                    return { issues: [{ message: 'Expected object' }] };
                }
                const value: Record<string, unknown> = {};
                const issues: { message: string; path: PropertyKey[] }[] = [];
                for (const [k, field] of entries) {
                    const std = field['~standard'];
                    const raw = (input as Record<string, unknown>)[k];
                    if (std) {
                        const r = std.validate(raw) as { value?: unknown; issues?: { message: string }[] };
                        if (r.issues) for (const i of r.issues) issues.push({ message: i.message, path: [k] });
                        else value[k] = r.value;
                    } else {
                        value[k] = raw;
                    }
                }
                return issues.length > 0 ? { issues } : { value };
            },
            jsonSchema: { input: emit, output: emit }
        }
    } as StandardSchemaWithJSON;
}

/** Wrap a Standard Schema that lacks `jsonSchema` (e.g. zod v3's `z.object({...})`) by synthesizing one from `_def`. */
function adaptStandardSchemaWithoutJson(schema: ZodV3Like): StandardSchemaWithJSON {
    const json = v3ToJsonSchema(schema);
    const emit = () => json;
    const std = schema['~standard'] as { version: 1; vendor: string; validate: (v: unknown) => unknown };
    return {
        '~standard': { ...std, jsonSchema: { input: emit, output: emit } }
    } as unknown as StandardSchemaWithJSON;
}

/**
 * Coerce a v1-style raw Zod shape (or empty object) to a {@linkcode StandardSchemaWithJSON}.
 * Standard Schemas pass through unchanged.
 */
export function coerceSchema(schema: unknown): StandardSchemaWithJSON | undefined {
    if (schema == null) return undefined;
    if (isStandardSchemaWithJSON(schema)) return schema;
    if (isZodRawShapeCompat(schema)) {
        const values = Object.values(schema as object);
        if (values.every(v => isZodV4Type(v))) {
            return z.object(schema as ZodRawShapeCompat) as unknown as StandardSchemaWithJSON;
        }
        return adaptRawShapeToStandard(schema as unknown as Record<string, ZodV3Like>);
    }
    if (isStandardSchema(schema)) {
        if ('_def' in (schema as object)) {
            return adaptStandardSchemaWithoutJson(schema as unknown as ZodV3Like);
        }
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
