/**
 * Shim purity pins: the schema-module re-export shims stay forwarding-only.
 *
 * The neutral schema sources live in @modelcontextprotocol/core
 * (packages/core/src/{schemas,auth,constants}.ts); core-internal keeps the old
 * module paths only as one-to-one re-export shims. If someone adds a new Zod
 * schema to a shim instead of to core, the name exists at the old path but
 * never reaches core's published entries — the exact drift the move was meant
 * to end. This pins the shims to pure forwarding: no zod import, no schema or
 * constant definitions, imports only from @modelcontextprotocol/core/internal.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const SHIMS = ['types/schemas.ts', 'shared/auth.ts', 'types/constants.ts'];

const NEW_HOME = 'new schemas/constants belong in packages/core/src (schemas.ts, auth.ts, constants.ts), not in the re-export shims';

/** Drop comments so header prose (which may mention `const`, zod, etc.) can't trip the code checks. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('core-internal schema shims only forward to @modelcontextprotocol/core', () => {
    for (const shim of SHIMS) {
        describe(shim, () => {
            const source = stripComments(readFileSync(join(srcDir, shim), 'utf8'));

            test('does not import zod', () => {
                expect(source, `${shim} imports zod — ${NEW_HOME}`).not.toMatch(/from\s+['"]zod/);
            });

            test('defines no schemas or constants', () => {
                expect(source, `${shim} builds a Zod schema — ${NEW_HOME}`).not.toMatch(/\bz\s*\.\s*[a-zA-Z]/);
                expect(source, `${shim} declares a local binding — ${NEW_HOME}`).not.toMatch(
                    /\b(?:const|let|var|function|class|enum|interface)\s/
                );
            });

            test('imports only from @modelcontextprotocol/core/internal', () => {
                for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
                    expect(m[1], `${shim} forwards from an unexpected module — ${NEW_HOME}`).toBe('@modelcontextprotocol/core/internal');
                }
            });
        });
    }

    test('types.ts re-exports the JSON value types from core as type-only', () => {
        const source = readFileSync(join(srcDir, 'types/types.ts'), 'utf8');
        expect(source).toMatch(/export type \{ JSONArray, JSONObject, JSONValue \} from '@modelcontextprotocol\/core\/internal';/);
        // A value re-export would make types.ts depend on core's runtime; keep it erasable.
        expect(source).not.toMatch(/export \{[^}]*JSON(?:Array|Object|Value)\b[^}]*\} from/);
    });
});
