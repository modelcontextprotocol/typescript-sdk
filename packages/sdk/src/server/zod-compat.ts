// v1 compat: `@modelcontextprotocol/sdk/server/zod-compat.js`
// v1 unified Zod v3 + v4 types. v2 is Zod v4-only, so these collapse to the
// v4 types. Prefer `StandardSchemaV1` / `StandardSchemaWithJSON` for new code.

import type * as z from 'zod';

/** @deprecated Use `StandardSchemaV1` (any Standard Schema) or a Zod type directly in v2. */
export type AnySchema = z.core.$ZodType;

/** @deprecated Use `Record<string, z.ZodType>` directly in v2. */
export type ZodRawShapeCompat = Record<string, AnySchema>;

/** @deprecated */
export type AnyObjectSchema = z.core.$ZodObject | AnySchema;

export type { StandardSchemaV1, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
