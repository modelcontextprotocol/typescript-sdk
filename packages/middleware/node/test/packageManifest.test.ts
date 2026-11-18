import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;

describe('package manifest', () => {
    // Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/3145.
    it('does not depend on Hono packages', () => {
        expect(manifest.dependencies ?? {}).not.toHaveProperty('@hono/node-server');
        expect(manifest.dependencies ?? {}).not.toHaveProperty('hono');
    });

    it('does not declare Hono packages as peer dependencies', () => {
        expect(manifest.peerDependencies ?? {}).not.toHaveProperty('@hono/node-server');
        expect(manifest.peerDependencies ?? {}).not.toHaveProperty('hono');
        expect(manifest.peerDependenciesMeta ?? {}).not.toHaveProperty('@hono/node-server');
        expect(manifest.peerDependenciesMeta ?? {}).not.toHaveProperty('hono');
    });
});
