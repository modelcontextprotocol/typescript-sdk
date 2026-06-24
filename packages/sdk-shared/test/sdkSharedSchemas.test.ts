import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as sdkShared from '../src/index.js';
import { CursorSchema, InitializeRequestSchema } from '../src/index.js';

describe('@modelcontextprotocol/sdk-shared', () => {
    it('re-exports spec schemas as working Zod objects', () => {
        // Round-trips a valid value and rejects an invalid one — proves the re-exports are the
        // real Zod schemas (not type-only aliases) and that `.parse`/`.safeParse` work.
        expect(CursorSchema.parse('abc')).toBe('abc');
        expect(InitializeRequestSchema.safeParse({}).success).toBe(false);
    });

    it('re-exports every *Schema declared in core (drift guard)', () => {
        // If core gains a new spec schema, this fails until it is added to src/index.ts.
        // (Renames/removals are already caught by typecheck — the named re-export would not resolve.)
        const src = readFileSync(fileURLToPath(new URL('../../core/src/types/schemas.ts', import.meta.url)), 'utf8');
        const coreSchemas = [...src.matchAll(/^export const (\w+Schema)\b/gm)]
            .map(m => m[1])
            .filter((name): name is string => name !== undefined);
        const exported = new Set(Object.keys(sdkShared));
        expect(coreSchemas.filter(name => !exported.has(name))).toEqual([]);
        expect(coreSchemas.length).toBeGreaterThanOrEqual(159);
    });
});
