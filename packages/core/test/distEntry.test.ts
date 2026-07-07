import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(pkgDir, 'dist', 'index.mjs');

// client, server, and server-legacy resolve their schema modules from this
// package's dist entry at runtime, so a missing or incomplete build breaks
// every consumer of a built package (the repo's CI test job never runs a
// standalone build — dist only exists if a test builds it, the same way
// client's barrelClean.test.ts builds client). Build on demand and pin the
// runtime surface the boundary depends on.
describe('@modelcontextprotocol/core dist entry', () => {
    beforeAll(() => {
        if (!existsSync(distEntry)) {
            execFileSync('pnpm', ['build'], { cwd: pkgDir, stdio: 'inherit' });
        }
    }, 120_000);

    test('root entry resolves and exposes the runtime schema surface', async () => {
        const mod = await import(distEntry);
        for (const name of [
            'CallToolResultSchema',
            'InitializeRequestSchema',
            'JSONRPCMessageSchema',
            'OAuthMetadataSchema',
            'OAuthProtectedResourceMetadataSchema'
        ]) {
            expect(mod[name], `core dist entry must export ${name}`).toBeDefined();
        }
        // The externalized boundary re-exports the whole spec schema surface;
        // a partial build would show up as a collapsed export count.
        expect(Object.keys(mod).length).toBeGreaterThan(150);
    });
});
