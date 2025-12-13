#!/usr/bin/env npx tsx
/**
 * Export all Zod schemas to JSON Schema format for comparison.
 *
 * This script is useful for verifying that schema changes don't break compatibility.
 *
 * Usage:
 *   # On main branch
 *   npx tsx scripts/export-schemas-to-json.ts > main-schemas.json
 *
 *   # On PR branch
 *   npx tsx scripts/export-schemas-to-json.ts > pr-schemas.json
 *
 *   # Compare
 *   diff main-schemas.json pr-schemas.json
 */

import { toJSONSchema } from 'zod/v4-mini';
import type { $ZodType } from 'zod/v4/core';
import * as types from '../dist/esm/types.js';

// Get all exports that end with "Schema" and are Zod schemas
const schemaExports: Record<string, unknown> = {};

for (const [name, value] of Object.entries(types)) {
    if (name.endsWith('Schema') && value && typeof value === 'object' && '_zod' in value) {
        try {
            // Convert to JSON Schema using Zod v4's built-in converter
            const jsonSchema = toJSONSchema(value as $ZodType, {
                target: 'draft-7',
            });
            schemaExports[name] = jsonSchema;
        } catch (e) {
            // Some schemas might not convert cleanly, note them
            schemaExports[name] = { error: `Failed to convert: ${e}` };
        }
    }
}

// Sort by name for deterministic output
const sortedSchemas: Record<string, unknown> = {};
for (const name of Object.keys(schemaExports).sort()) {
    sortedSchemas[name] = schemaExports[name];
}

// Output as pretty-printed JSON
console.log(JSON.stringify(sortedSchemas, null, 2));
