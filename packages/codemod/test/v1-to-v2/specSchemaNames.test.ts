import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SPEC_SCHEMA_NAMES } from '../../src/migrations/v1-to-v2/mappings/specSchemaNames';

describe('SPEC_SCHEMA_NAMES (codemod schema-routing allowlist)', () => {
    it("matches @modelcontextprotocol/core's exported schema set exactly (drift guard)", () => {
        // The import transform routes a `*Schema` symbol from sdk/types.js to core only when the
        // symbol's (rename-resolved) name is in this set. It must therefore equal core's actual
        // public exports: a name missing here would be misrouted to client/server (which export no Zod
        // schema values), and a name here that core does not export would produce a broken import.
        // Read core's barrel directly so the two cannot silently drift.
        const src = readFileSync(fileURLToPath(new URL('../../../core/src/index.ts', import.meta.url)), 'utf8');
        const block = src.slice(src.indexOf('export {') + 'export {'.length, src.indexOf('} from'));
        const sdkSharedExports = [...new Set([...block.matchAll(/\b(\w+Schema)\b/g)].map(m => m[1]))].sort();
        expect([...SPEC_SCHEMA_NAMES].sort()).toEqual(sdkSharedExports);
        expect(sdkSharedExports.length).toBeGreaterThanOrEqual(154);
    });
});
