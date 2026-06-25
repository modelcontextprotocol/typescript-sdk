import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as sdkShared from '../src/index.js';
import { CursorSchema, InitializeRequestSchema, OAuthTokensSchema } from '../src/index.js';

function readCore(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function exportedSchemaConsts(src: string, re: RegExp): string[] {
    return [...src.matchAll(re)].map(m => m[1]).filter((name): name is string => name !== undefined && /^[A-Z]/.test(name));
}

describe('@modelcontextprotocol/sdk-shared', () => {
    it('re-exports spec + OAuth schemas as working Zod objects', () => {
        // Round-trips valid/invalid values — proves the re-exports are real Zod schemas (not type-only
        // aliases) and that `.parse`/`.safeParse` work, for both the spec and the OAuth group.
        expect(CursorSchema.parse('abc')).toBe('abc');
        expect(InitializeRequestSchema.safeParse({}).success).toBe(false);
        expect(OAuthTokensSchema.safeParse({}).success).toBe(false);
        expect(OAuthTokensSchema.safeParse({ access_token: 'tok', token_type: 'Bearer' }).success).toBe(true);
    });

    it('re-exports exactly core’s spec + OAuth schemas — no internal helpers (drift guard)', () => {
        // sdk-shared's public surface is two SEPARATE groups, mirroring core's own spec-vs-auth split:
        //   1. spec `*Schema` constants from core/src/types/schemas.ts (minus internal helpers with no
        //      public spec type — they must NOT leak), mirroring core's SPEC_SCHEMA_KEYS allowlist; and
        //   2. the auth `*Schema` constants registered in core's `authSchemas` object (specTypeSchema.ts)
        //      — i.e. the auth schemas that have a public spec type. Reading that object directly (not a
        //      name prefix) is the source of truth, so a new auth schema added to core is required here
        //      automatically; typeless internal helpers (SafeUrlSchema, OptionalSafeUrlSchema) stay out
        //      because they are not in `authSchemas`.
        // Read the core sources directly so the groups cannot silently drift.
        const SPEC_INTERNAL_HELPERS = [
            'BaseRequestParamsSchema',
            'ClientTasksCapabilitySchema',
            'ListChangedOptionsBaseSchema',
            'NotificationsParamsSchema',
            'ServerTasksCapabilitySchema'
        ];
        const specSchemas = exportedSchemaConsts(readCore('../../core/src/types/schemas.ts'), /^export const (\w+Schema)\b/gm).filter(
            name => !SPEC_INTERNAL_HELPERS.includes(name)
        );
        const specTypeSrc = readCore('../../core/src/types/specTypeSchema.ts');
        const authStart = specTypeSrc.indexOf('const authSchemas = {');
        const authObj = specTypeSrc.slice(authStart, specTypeSrc.indexOf('} as const', authStart));
        const authSchemas = exportedSchemaConsts(authObj, /\b(\w+Schema)\b/g);

        const expected = [...specSchemas, ...authSchemas].sort();
        const exported = Object.keys(sdkShared).sort();
        // Exact match, both directions: a new core spec/auth schema missing here fails (we forgot to
        // re-export it), and any internal helper / non-spec symbol that leaks here also fails.
        expect(exported).toEqual(expected);
        expect(specSchemas.length).toBeGreaterThanOrEqual(154);
        expect(authSchemas.length).toBe(12);
    });
});
