import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { v1ToV2Migration } from '../../src/migrations/v1-to-v2';
import { run } from '../../src/runner';
import { discoverManifests, ownerManifest, updatePackageJson } from '../../src/utils/packageJsonUpdater';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'codemod-manifests-'));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function writeJson(rel: string, value: unknown, indent = '  '): string {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value, null, indent) + '\n');
    return p;
}

function readJson(p: string): Record<string, unknown> {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

describe('discoverManifests', () => {
    it('returns the nearest manifest walking up from the target directory', () => {
        const root = writeJson('package.json', { name: 'app' });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        const manifests = discoverManifests(path.join(dir, 'src'));
        expect(manifests.map(m => m.path)).toEqual([root]);
    });

    it('includes npm/yarn workspace members', () => {
        const root = writeJson('package.json', { name: 'mono', workspaces: ['packages/*'] });
        const a = writeJson('packages/a/package.json', { name: 'a' });
        const b = writeJson('packages/b/package.json', { name: 'b' });
        const manifests = discoverManifests(dir);
        expect(manifests.map(m => m.path).toSorted()).toEqual([root, a, b].toSorted());
    });

    it('includes pnpm-workspace.yaml members', () => {
        const root = writeJson('package.json', { name: 'mono' });
        writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - apps/web\n");
        const a = writeJson('packages/a/package.json', { name: 'a' });
        const web = writeJson('apps/web/package.json', { name: 'web' });
        const manifests = discoverManifests(dir);
        expect(manifests.map(m => m.path).toSorted()).toEqual([root, a, web].toSorted());
    });
});

describe('ownerManifest', () => {
    it('assigns a file to the longest-prefix manifest directory', () => {
        writeJson('package.json', { name: 'mono', workspaces: ['packages/*'] });
        writeJson('packages/a/package.json', { name: 'a' });
        const manifests = discoverManifests(dir);
        const inMember = ownerManifest(path.join(dir, 'packages/a/src/index.ts'), manifests);
        const inRoot = ownerManifest(path.join(dir, 'scripts/build.ts'), manifests);
        expect(inMember?.path).toBe(path.join(dir, 'packages/a/package.json'));
        expect(inRoot?.path).toBe(path.join(dir, 'package.json'));
    });
});

describe('updatePackageJson', () => {
    it('swaps the v1 dependency for the used v2 packages in a single manifest', () => {
        const manifest = writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', express: '^5.0.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(
            manifests,
            new Map([[manifest, new Set(['@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio'])]]),
            false
        );
        expect(changes).toHaveLength(1);
        expect(changes[0]!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(changes[0]!.added).toEqual(['@modelcontextprotocol/client']);
        const after = readJson(manifest);
        const deps = after.dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(deps['@modelcontextprotocol/client']).toBeDefined();
        expect(deps.express).toBe('^5.0.0');
    });

    it('updates workspace-member manifests independently of the root', () => {
        writeJson('package.json', { name: 'mono', workspaces: ['packages/*'] });
        const member = writeJson('packages/a/package.json', {
            name: 'a',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[member, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes).toHaveLength(1);
        expect(changes[0]!.packageJsonPath).toBe(member);
        const deps = readJson(member).dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(deps['@modelcontextprotocol/server']).toBeDefined();
    });

    it('places additions in devDependencies when v1 lived there', () => {
        const manifest = writeJson('package.json', {
            name: 'app',
            devDependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        updatePackageJson(discoverManifests(dir), new Map([[manifest, new Set(['@modelcontextprotocol/server'])]]), false);
        const after = readJson(manifest);
        expect((after.devDependencies as Record<string, string>)['@modelcontextprotocol/server']).toBeDefined();
        expect(after.dependencies).toBeUndefined();
    });

    it('warns on a zod range below the v2 floor without touching it', () => {
        const manifest = writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '^3.25.0' }
        });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes[0]!.warnings?.[0]).toContain('zod');
        expect((readJson(manifest).dependencies as Record<string, string>).zod).toBe('^3.25.0');
    });

    it('does not warn on zod ranges that satisfy the floor', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '^4.2.0' }
        });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('reports a zod warning even for manifests without the v1 dependency', () => {
        writeJson('package.json', { name: 'app', dependencies: { zod: '~4.1.0' } });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes).toHaveLength(1);
        expect(changes[0]!.removed).toEqual([]);
        expect(changes[0]!.warnings?.[0]).toContain('zod');
    });

    it('dry run reports without writing', () => {
        const manifest = writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const before = readFileSync(manifest, 'utf8');
        const changes = updatePackageJson(discoverManifests(dir), new Map([[manifest, new Set(['@modelcontextprotocol/client'])]]), true);
        expect(changes[0]!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(readFileSync(manifest, 'utf8')).toBe(before);
    });

    it('preserves 4-space indentation', () => {
        const manifest = writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } }, '    ');
        updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(readFileSync(manifest, 'utf8')).toContain('\n    "name"');
    });
});

describe('run() manifest integration', () => {
    it('adds the v2 packages an already-migrated workspace member needs when removing its v1 dependency', () => {
        writeJson('package.json', { name: 'mono', workspaces: ['packages/*'] });
        const member = writeJson('packages/a/package.json', {
            name: 'a',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        mkdirSync(path.join(dir, 'packages/a/src'), { recursive: true });
        // Source is ALREADY on v2 imports — nothing for the import transform to rewrite.
        writeFileSync(
            path.join(dir, 'packages/a/src/index.ts'),
            "import { Client } from '@modelcontextprotocol/client';\nexport const c = new Client({ name: 'x', version: '1' });\n"
        );

        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: false });

        const change = result.packageJsonChanges?.find(c => c.packageJsonPath === member);
        expect(change).toBeDefined();
        expect(change!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(change!.added).toContain('@modelcontextprotocol/client');
        const deps = readJson(member).dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(deps['@modelcontextprotocol/client']).toBeDefined();
    });

    it('survives a directory symlink cycle without following it', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(
            path.join(dir, 'src/index.ts'),
            "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport { Client };\n"
        );
        // A cycle: src/loop -> the project root.
        symlinkSync(dir, path.join(dir, 'src', 'loop'), 'dir');

        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: false });

        // The symlinked re-entry must not be followed: exactly one source file seen.
        expect(result.fileResults.map(fr => fr.filePath)).toHaveLength(1);
        expect(result.packageJsonChanges?.[0]?.removed).toEqual(['@modelcontextprotocol/sdk']);
    });
});

describe('hoisted-dependency roll-up', () => {
    it('credits member usage to the root when only the root declares v1', () => {
        const root = writeJson('package.json', {
            name: 'mono',
            workspaces: ['packages/*'],
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const member = writeJson('packages/a/package.json', { name: 'a' });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[member, new Set(['@modelcontextprotocol/client'])]]), false);
        expect(changes).toHaveLength(1);
        expect(changes[0]!.packageJsonPath).toBe(root);
        expect(changes[0]!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(changes[0]!.added).toEqual(['@modelcontextprotocol/client']);
    });
});

describe('review-round hardening', () => {
    it('ownerManifest tolerates mixed path separators (ts-morph emits forward slashes)', () => {
        const manifests = [{ dir: 'C:\\repo\\packages\\a', path: 'C:\\repo\\packages\\a\\package.json' }];
        const owner = ownerManifest('C:/repo/packages/a/src/index.ts', manifests);
        expect(owner).toBe(manifests[0]);
    });

    it('parses pnpm-workspace.yaml entries with inline comments', () => {
        writeJson('package.json', { name: 'mono' });
        writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*' # the libs\n");
        const a = writeJson('packages/a/package.json', { name: 'a' });
        expect(discoverManifests(dir).map(m => m.path)).toContain(a);
    });

    it('does not warn on a zod disjunction with a satisfying alternative', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.25.0 || ^4.5.0' } });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('warns on comparator and workspace-protocol ranges below the floor', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '>=3 <4' } });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes[0]!.warnings?.[0]).toContain('zod');
    });

    it('honors a relative --ignore pattern during collection', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        mkdirSync(path.join(dir, 'src/legacy'), { recursive: true });
        writeFileSync(
            path.join(dir, 'src/index.ts'),
            "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport { Client };\n"
        );
        writeFileSync(
            path.join(dir, 'src/legacy/old.ts'),
            "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport { Client };\n"
        );
        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: true, ignore: ['src/legacy/**'] });
        const touched = result.fileResults.map(fr => fr.filePath);
        expect(touched.some(f => f.includes('src/index.ts'))).toBe(true);
        expect(touched.some(f => f.includes('legacy'))).toBe(false);
    });

    it('counts a vi.doMock specifier toward manifest additions', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        mkdirSync(path.join(dir, 'test'), { recursive: true });
        writeFileSync(path.join(dir, 'test/mocked.test.ts'), "vi.doMock('@modelcontextprotocol/server', () => ({}));\nexport {};\n");
        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: true });
        expect(result.packageJsonChanges?.[0]?.added).toContain('@modelcontextprotocol/server');
    });
});
