// zod-json-schema-compat.ts
// ----------------------------------------------------
// JSON Schema conversion for both Zod v3 and Zod v4 (Mini)
// v3 uses your vendored converter; v4 uses Mini's toJSONSchema
// ----------------------------------------------------

import type * as z3 from 'zod/v3';
import type * as z4c from 'zod/v4/core';

import * as z4mini from 'zod/v4-mini';

import { AnyObjectSchema, isZ4Schema } from './zod-compat.js';
import { zodToJsonSchema } from '../_vendor/zod-to-json-schema/index.js';

type JsonSchema = Record<string, unknown>;

// Options accepted by call sites; we map them appropriately
export type CommonOpts = {
    // v3-style toggles
    strictUnions?: boolean;
    pipeStrategy?: 'input' | 'output';
    // Targets (accept legacy labels; map to Mini drafts)
    target?: 'jsonSchema7' | 'jsonSchema2019-09' | 'openapi-3.0' | 'draft-4' | 'draft-7' | 'draft-2020-12';
};

// Map legacy targets -> Mini targets
function mapMiniTarget(t: CommonOpts['target'] | undefined): 'draft-7' | 'draft-2020-12' {
    // Mini's toJSONSchema currently supports only these two drafts.
    if (!t) return 'draft-7';
    if (t === 'jsonSchema7' || t === 'draft-7') return 'draft-7';
    if (t === 'jsonSchema2019-09' || t === 'draft-2020-12') return 'draft-2020-12';
    // Fallback for unsupported values like 'draft-4' or 'openapi-3.0'
    return 'draft-7';
}

// --- Overloads for clean narrowing at call sites ---
export function toJsonSchemaCompat(schema: AnyObjectSchema, opts?: CommonOpts): JsonSchema;
export function toJsonSchemaCompat(schema: z4c.$ZodType, opts?: CommonOpts): JsonSchema;
export function toJsonSchemaCompat(schema: z3.ZodTypeAny, opts?: CommonOpts): JsonSchema;
export function toJsonSchemaCompat(schema: z3.ZodTypeAny | z4c.$ZodType, opts?: CommonOpts): JsonSchema {
    if (isZ4Schema(schema as z4c.$ZodType)) {
        // v4 branch — use Mini
        // Cast specifically to Mini's $ZodType to select the correct overload
        const miniSchema = schema as unknown as z4c.$ZodType;
        return z4mini.toJSONSchema(miniSchema, {
            target: mapMiniTarget(opts?.target), // "draft-7" by default
            io: (opts?.pipeStrategy as 'input' | 'output') ?? 'input'
        }) as JsonSchema;
    }

    // v3 branch — use vendored converter
    return zodToJsonSchema(
        schema as z3.ZodTypeAny,
        {
            strictUnions: opts?.strictUnions ?? true,
            pipeStrategy: opts?.pipeStrategy ?? 'input'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any // vendored types
    ) as JsonSchema;
}
