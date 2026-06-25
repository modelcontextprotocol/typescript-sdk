import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUTH_SCHEMA_NAMES, AUTH_SCHEMA_NAMES_NO_V2_PUBLIC_EXPORT } from '../../src/migrations/v1-to-v2/mappings/authSchemaNames';

describe('AUTH_SCHEMA_NAMES (codemod auth schema-routing allowlist)', () => {
    it('routes only auth schemas that @modelcontextprotocol/core exports (drift guard)', () => {
        // The import transform routes a `*Schema` symbol from sdk/shared/auth.js to core only when
        // its name is in AUTH_SCHEMA_NAMES, so EVERY name here MUST be exported by core — otherwise
        // the rewritten import would have no exported member. AUTH_SCHEMA_NAMES is the v1 auth-schema set,
        // a SUBSET of core's auth exports: core may export more (v2-only schemas such as
        // IdJagTokenExchangeResponseSchema) that v1 never had and the codemod never encounters. Read
        // core's barrel directly (the `export { … } from '…/core-internal/auth'` block) so they cannot drift.
        const src = readFileSync(fileURLToPath(new URL('../../../core/src/index.ts', import.meta.url)), 'utf8');
        const closeIdx = src.indexOf("} from '@modelcontextprotocol/core-internal/auth'");
        const openIdx = src.lastIndexOf('export {', closeIdx);
        const block = src.slice(openIdx + 'export {'.length, closeIdx);
        const coreAuthExports = new Set([...block.matchAll(/\b(\w+Schema)\b/g)].map(m => m[1]));

        const notExportedByCore = [...AUTH_SCHEMA_NAMES].filter(name => !coreAuthExports.has(name));
        expect(notExportedByCore).toEqual([]);
        // The v1 auth-schema set is frozen; pin its size so an accidental add/remove is caught.
        expect(AUTH_SCHEMA_NAMES.size).toBe(11);
    });

    it('keeps the no-v2-home auth schemas OUT of the routing allowlist', () => {
        // SafeUrlSchema/OptionalSafeUrlSchema have no public v2 export, so they must NOT be routed to
        // core (the import transform flags them instead). Guard the two sets stay disjoint.
        for (const name of AUTH_SCHEMA_NAMES_NO_V2_PUBLIC_EXPORT) {
            expect(AUTH_SCHEMA_NAMES.has(name)).toBe(false);
        }
        expect([...AUTH_SCHEMA_NAMES_NO_V2_PUBLIC_EXPORT].sort()).toEqual(['OptionalSafeUrlSchema', 'SafeUrlSchema']);
    });
});
