// zod-json-schema-compat.ts
// ----------------------------------------------------
// JSON Schema conversion for both Zod v3 and Zod v4 (Mini)
// v3 uses your vendored converter; v4 uses Mini's toJSONSchema
// ----------------------------------------------------

import type * as z3 from 'zod/v3';
import type * as z4c from 'zod/v4/core';

import * as z4mini from 'zod/v4-mini';

import { AnySchema, AnyObjectSchema, getObjectShape, safeParse, isZ4Schema, getLiteralValue } from './zod-compat.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

type JsonSchema = Record<string, unknown>;

// Options accepted by call sites; we map them appropriately
type CommonOpts = {
    strictUnions?: boolean;
    pipeStrategy?: 'input' | 'output';
    target?: 'jsonSchema7' | 'draft-7' | 'jsonSchema2019-09' | 'draft-2020-12';
};

function mapMiniTarget(t: CommonOpts['target'] | undefined): 'draft-7' | 'draft-2020-12' {
    if (!t) return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7') return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12') return 'draft-2020-12';
    return 'draft-7'; // fallback
}

export function toJsonSchemaCompat(schema: AnyObjectSchema, opts?: CommonOpts): JsonSchema {
    if (isZ4Schema(schema)) {
        // v4 branch — use Mini's built-in toJSONSchema.
        //
        // `io` is always 'input' here, regardless of `opts.pipeStrategy`: the server
        // never runs a tool's `structuredContent` through the schema's output
        // transform/default-injection, it ships the tool's raw object as-is. So the
        // advertised schema — for both input *and* output — must describe that raw
        // shape: fields with `.default()` are optional (the caller/tool may omit
        // them), matching zod's 'input' semantics rather than 'output' (which would
        // mark them required, as if defaults had already been applied).
        //
        // `unrepresentable: 'any'` + the `override` below keep a single
        // unsupported field (e.g. `z.date()`, which v4 refuses to represent by
        // default) from crashing the entire `tools/list` response; `z.date()`
        // specifically is rewritten to the RFC 3339 string format that
        // `JSON.stringify` actually produces on the wire for a `Date`.
        return z4mini.toJSONSchema(schema as z4c.$ZodType, {
            target: mapMiniTarget(opts?.target),
            io: 'input',
            unrepresentable: 'any',
            override: ctx => {
                if ((ctx.zodSchema as unknown as { _zod?: { def?: { type?: string } } })._zod?.def?.type === 'date') {
                    ctx.jsonSchema.type = 'string';
                    ctx.jsonSchema.format = 'date-time';
                }
            }
        }) as JsonSchema;
    }

    // v3 branch — use vendored converter
    return zodToJsonSchema(schema as z3.ZodTypeAny, {
        strictUnions: opts?.strictUnions ?? true,
        pipeStrategy: opts?.pipeStrategy ?? 'input'
    }) as JsonSchema;
}

export function getMethodLiteral(schema: AnyObjectSchema): string {
    const shape = getObjectShape(schema);
    const methodSchema = shape?.method as AnySchema | undefined;
    if (!methodSchema) {
        throw new Error('Schema is missing a method literal');
    }

    const value = getLiteralValue(methodSchema);
    if (typeof value !== 'string') {
        throw new Error('Schema method literal must be a string');
    }

    return value;
}

export function parseWithCompat(schema: AnySchema, data: unknown): unknown {
    const result = safeParse(schema, data);
    if (!result.success) {
        throw result.error;
    }
    return result.data;
}
