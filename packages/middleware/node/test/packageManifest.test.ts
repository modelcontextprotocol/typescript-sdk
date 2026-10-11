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
    // Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/2882:
    // `@hono/node-server` declares `hono` as a required peer. If this package only lists
    // `hono` as an optional peer, strict pnpm installs fail with ERR_PNPM_PEER_DEP_ISSUES.
    it('declares hono as a regular dependency to satisfy the @hono/node-server peer', () => {
        expect(manifest.dependencies).toHaveProperty('@hono/node-server');
        expect(manifest.dependencies).toHaveProperty('hono');
    });

    it('does not declare hono as a peer dependency', () => {
        expect(manifest.peerDependencies ?? {}).not.toHaveProperty('hono');
        expect(manifest.peerDependenciesMeta ?? {}).not.toHaveProperty('hono');
    });
});
