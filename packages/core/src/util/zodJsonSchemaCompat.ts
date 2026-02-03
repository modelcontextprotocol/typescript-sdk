// zod-json-schema-compat.ts
// ----------------------------------------------------
// JSON Schema conversion for Zod v4 (Mini)
// ----------------------------------------------------

import type * as z4c from 'zod/v4/core';
import * as z4mini from 'zod/v4-mini';

import type { AnyObjectSchema, AnySchema, SchemaOutput } from './zodCompat.js';
import { safeParse } from './zodCompat.js';

type JsonSchema = Record<string, unknown>;

// Options accepted by call sites
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
    return z4mini.toJSONSchema(schema as z4c.$ZodType, {
        target: mapMiniTarget(opts?.target),
        io: opts?.pipeStrategy ?? 'input'
    }) as JsonSchema;
}

export function parseWithCompat<T extends AnySchema>(schema: T, data: unknown): SchemaOutput<T> {
    const result = safeParse(schema, data);
    if (!result.success) {
        throw result.error;
    }
    return result.data as SchemaOutput<T>;
}
