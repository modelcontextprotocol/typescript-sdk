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

    it('re-exports exactly the spec schemas declared in core — no internal helpers (drift guard)', () => {
        // sdk-shared's public surface is the spec `*Schema` constants ONLY. Some `*Schema` consts in
        // core's schemas.ts are internal building blocks with no public spec type; they must NOT leak
        // here. This list mirrors the exclusion in core's specTypeSchema.ts (SPEC_SCHEMA_KEYS) — keep
        // the two in sync.
        const INTERNAL_HELPER_SCHEMAS = [
            'BaseRequestParamsSchema',
            'ClientTasksCapabilitySchema',
            'ListChangedOptionsBaseSchema',
            'NotificationsParamsSchema',
            'ServerTasksCapabilitySchema'
        ];
        const src = readFileSync(fileURLToPath(new URL('../../core/src/types/schemas.ts', import.meta.url)), 'utf8');
        const coreSchemas = [...src.matchAll(/^export const (\w+Schema)\b/gm)]
            .map(m => m[1])
            .filter((name): name is string => name !== undefined && /^[A-Z]/.test(name));
        // The spec schema set = every PascalCase core `*Schema` const minus the internal helpers.
        const specSchemas = coreSchemas.filter(name => !INTERNAL_HELPER_SCHEMAS.includes(name)).sort();
        const exported = Object.keys(sdkShared).sort();
        // Exact match, both directions: a new core spec schema missing here fails (we forgot to
        // re-export it), and any internal helper / non-spec symbol that leaks here also fails.
        expect(exported).toEqual(specSchemas);
        expect(specSchemas.length).toBeGreaterThanOrEqual(154);
    });
});
