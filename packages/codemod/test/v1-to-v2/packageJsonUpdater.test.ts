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

    it('reports workspace-member manifests without modifying them', () => {
        writeJson('package.json', { name: 'mono', workspaces: ['packages/*'] });
        const member = writeJson('packages/a/package.json', {
            name: 'a',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[member, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes).toHaveLength(1);
        expect(changes[0]!.packageJsonPath).toBe(member);
        expect(changes[0]!.applied).toBe(false);
        expect(changes[0]!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(changes[0]!.added).toEqual(['@modelcontextprotocol/server']);
        // The member manifest is reported, never written.
        const deps = readJson(member).dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBe('^1.29.0');
        expect(deps['@modelcontextprotocol/server']).toBeUndefined();
    });

    it('writes the nearest manifest and reports a member that also declares v1', () => {
        const root = writeJson('package.json', {
            name: 'mono',
            workspaces: ['packages/*'],
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const member = writeJson('packages/a/package.json', {
            name: 'a',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(
            manifests,
            new Map([
                [root, new Set(['@modelcontextprotocol/client'])],
                [member, new Set(['@modelcontextprotocol/server'])]
            ]),
            false
        );
        const rootChange = changes.find(c => c.packageJsonPath === root);
        const memberChange = changes.find(c => c.packageJsonPath === member);
        expect(rootChange?.applied).toBe(true);
        expect(memberChange?.applied).toBe(false);
        expect((readJson(root).dependencies as Record<string, string>)['@modelcontextprotocol/sdk']).toBeUndefined();
        expect((readJson(member).dependencies as Record<string, string>)['@modelcontextprotocol/sdk']).toBe('^1.29.0');
        expect(memberChange?.added).toEqual(['@modelcontextprotocol/server']);
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
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('zod');
        expect((readJson(manifest).dependencies as Record<string, string>).zod).toBe('^3.25.0');
    });

    it('does not warn on zod ranges that satisfy the floor', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '^4.2.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('reports a zod warning for v2-declaring manifests without the v1 dependency', () => {
        writeJson('package.json', { name: 'app', dependencies: { zod: '~4.1.0', '@modelcontextprotocol/server': '^2.0.0-alpha.3' } });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
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
        // `applied` marks the write target even in a dry run (nothing is written either way).
        expect(changes[0]!.applied).toBe(true);
        expect(readFileSync(manifest, 'utf8')).toBe(before);
    });

    it('preserves 4-space indentation', () => {
        const manifest = writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } }, '    ');
        updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(readFileSync(manifest, 'utf8')).toContain('\n    "name"');
    });
});

describe('run() manifest integration', () => {
    it('reports the v2 packages an already-migrated workspace member needs without modifying it', () => {
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
        expect(change!.applied).toBe(false);
        expect(change!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(change!.added).toContain('@modelcontextprotocol/client');
        // The member manifest is a workspace member, not the nearest manifest — reported only.
        const deps = readJson(member).dependencies as Record<string, string>;
        expect(deps['@modelcontextprotocol/sdk']).toBe('^1.29.0');
        expect(deps['@modelcontextprotocol/client']).toBeUndefined();
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
        expect(result.packageJsonChanges?.[0]?.applied).toBe(true);
        expect(result.packageJsonChanges?.[0]?.removed).toEqual(['@modelcontextprotocol/sdk']);
    });
});

describe('hoisted-dependency roll-up', () => {
    it('credits member usage to the root when only the root declares v1, and notes the hoist', () => {
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
        expect(changes[0]!.applied).toBe(true);
        expect(changes[0]!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(changes[0]!.added).toEqual(['@modelcontextprotocol/client']);
        expect(changes[0]!.notes?.[0]).toContain('packages/a');
    });

    it('does not note a member whose imports map to no publishable v2 package', () => {
        const root = writeJson('package.json', {
            name: 'mono',
            workspaces: ['packages/*'],
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        const member = writeJson('packages/a/package.json', { name: 'a' });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[member, new Set(['@modelcontextprotocol/core-internal'])]]), false);
        expect(changes).toHaveLength(1);
        expect(changes[0]!.packageJsonPath).toBe(root);
        expect(changes[0]!.notes).toBeUndefined();
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
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('describes the compile-time symptom for zod 4.0/4.1 ranges', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '~4.1.0' } });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('TS2769');
    });

    it('describes both symptom paths for zod-3 ranges', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.25.0' } });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('zod/v4 subpath');
        expect(changes[0]!.warnings?.[0]).toContain('tools/list');
    });

    it('does not warn on open-ended floors and caret-4 ranges that can resolve past the floor', () => {
        for (const range of ['>=4.0.0', '>=3', '^4.1.5', '4.x', '~4', '>=4.0 <5', '<=4.2', '3.25.0 - 4.5.0']) {
            writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: range } });
            const manifests = discoverManifests(dir);
            const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
            expect(changes[0]!.warnings, range).toBeUndefined();
        }
    });

    it('uses the zod-3 narrative for upper bounds that cap resolution below 4', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '<4.0' } });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('tools/list');
        expect(changes[0]!.warnings?.[0]).not.toContain('TS2769');
    });

    it('uses the compile-time narrative for hyphen ranges resolving into 4.0/4.1', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '3.25.0 - 4.1.99' } });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('TS2769');
    });

    it('warns on comparator and workspace-protocol ranges below the floor', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '>=3 <4' } });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
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

describe('single-file targets and mcp import counts (B2)', () => {
    it('scopes the run to one file and reports (without applying) the owning manifest edit', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(
            path.join(dir, 'src/a.ts'),
            "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport { Client };\n"
        );
        writeFileSync(
            path.join(dir, 'src/b.ts'),
            "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nexport { McpServer };\n"
        );

        const result = run(v1ToV2Migration, { targetDir: path.join(dir, 'src/a.ts'), dryRun: false });

        expect(result.fileResults.map(fr => fr.filePath)).toHaveLength(1);
        expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toContain('@modelcontextprotocol/client');
        // The sibling stays untouched.
        expect(readFileSync(path.join(dir, 'src/b.ts'), 'utf8')).toContain('@modelcontextprotocol/sdk/server/mcp.js');
        expect(result.packageJsonChanges?.[0]?.removed).toEqual(['@modelcontextprotocol/sdk']);
        // Report-only in file mode: a one-file view must not strip the dependency the
        // rest of the package still needs.
        expect((readJson(path.join(dir, 'package.json')).dependencies as Record<string, string>)['@modelcontextprotocol/sdk']).toBe(
            '^1.29.0'
        );
    });

    it('reports how many files already import the v2 packages', () => {
        writeJson('package.json', { name: 'app' });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(path.join(dir, 'src/done.ts'), "import { Client } from '@modelcontextprotocol/client';\nexport { Client };\n");
        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: true });
        expect(result.mcpImportFiles).toBe(1);
        expect(result.filesChanged).toBe(0);
    });

    it('reports zero mcp import files for a tree that never used the SDK', () => {
        writeJson('package.json', { name: 'app' });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(path.join(dir, 'src/other.ts'), 'export const x = 1;\n');
        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: true });
        expect(result.mcpImportFiles).toBe(0);
    });
});

describe('zod warning relevance gate (B4, #40)', () => {
    it('suppresses the zod note when the swap removes the dep and adds nothing', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '^3.25.0' }
        });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes[0]!.removed).toEqual(['@modelcontextprotocol/sdk']);
        expect(changes[0]!.added).toEqual([]);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('suppresses warning-only entries for manifests with no MCP relation', () => {
        writeJson('package.json', { name: 'app', dependencies: { zod: '^3.25.0' } });
        const changes = updatePackageJson(discoverManifests(dir), new Map(), false);
        expect(changes).toHaveLength(0);
    });
});

describe('advisory-only diagnostics at the runner level (B3)', () => {
    it('keeps advisories on first runs (file changed by imports) and drops them on re-runs', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        const file = path.join(dir, 'src/server.ts');
        writeFileSync(
            file,
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `const inputSchema = mySchema;`,
                `const server = new McpServer({ name: 'x', version: '1' });`,
                `server.registerTool('t', { inputSchema }, cb);`,
                ''
            ].join('\n')
        );

        // First run: the imports transform changes the file, so the verify-advisory ships.
        const first = run(v1ToV2Migration, { targetDir: dir, dryRun: false });
        expect(first.diagnostics.some(d => d.message.includes('Shorthand'))).toBe(true);

        // Second run: nothing changes — the advisory stays quiet.
        const second = run(v1ToV2Migration, { targetDir: dir, dryRun: false });
        expect(second.filesChanged).toBe(0);
        expect(second.diagnostics.some(d => d.message.includes('Shorthand'))).toBe(false);
    });
});

describe('zod added for injection in zod-less manifests (B6, #53)', () => {
    it('adds zod as devDependency when injection fired only in test files', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        const manifests = discoverManifests(dir);
        const testFile = path.join(dir, 'test', 'unit', 'a.test.ts');
        const changes = updatePackageJson(
            manifests,
            new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]),
            false,
            new Map([[manifests[0]!.path, [testFile]]])
        );
        expect(changes[0]!.added).toContain('zod');
        const written = JSON.parse(readFileSync(manifests[0]!.path, 'utf8'));
        expect(written.devDependencies.zod).toBe('^4.2.0');
    });

    it('adds zod to the v1 section for source-file injection', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        const manifests = discoverManifests(dir);
        const srcFile = path.join(dir, 'src', 'server.ts');
        const changes = updatePackageJson(
            manifests,
            new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]),
            false,
            new Map([[manifests[0]!.path, [srcFile]]])
        );
        expect(changes[0]!.added).toContain('zod');
        const written = JSON.parse(readFileSync(manifests[0]!.path, 'utf8'));
        expect(written.dependencies.zod).toBe('^4.2.0');
    });

    it('does not add zod when the manifest already declares it', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '^4.3.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(
            manifests,
            new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]),
            false,
            new Map([[manifests[0]!.path, [path.join(dir, 'src', 'a.ts')]]])
        );
        expect(changes[0]!.added).not.toContain('zod');
    });
});

describe('zod injection roll-up and path classification (B6 review)', () => {
    it('rolls injected files up to the v1-declaring ancestor for hoisted members', () => {
        writeJson('package.json', {
            name: 'root',
            workspaces: ['packages/*'],
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        mkdirSync(path.join(dir, 'packages', 'api', 'src'), { recursive: true });
        writeJson('packages/api/package.json', { name: 'api' });
        const manifests = discoverManifests(dir);
        const memberPath = manifests.find(m => m.path.includes('api'))!.path;
        const rootPath = manifests.find(m => !m.path.includes('api'))!.path;
        const srcFile = path.join(dir, 'packages', 'api', 'src', 'server.ts');
        const changes = updatePackageJson(
            manifests,
            new Map([[memberPath, new Set(['@modelcontextprotocol/server'])]]),
            false,
            new Map([[memberPath, [srcFile]]])
        );
        const rootChange = changes.find(c => c.packageJsonPath === rootPath);
        expect(rootChange!.added).toContain('zod');
    });

    it('classifies test paths relative to the package, not the checkout', () => {
        // The temp dir itself contains no test segment; simulate one by nesting.
        const nested = path.join(dir, 'tests', 'build', 'repo');
        mkdirSync(path.join(nested, 'src'), { recursive: true });
        writeFileSync(
            path.join(nested, 'package.json'),
            JSON.stringify({ name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } })
        );
        const manifests = discoverManifests(nested);
        const srcFile = path.join(nested, 'src', 'server.ts');
        const changes = updatePackageJson(
            manifests,
            new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]),
            false,
            new Map([[manifests[0]!.path, [srcFile]]])
        );
        expect(changes[0]!.added).toContain('zod');
        const written = JSON.parse(readFileSync(manifests[0]!.path, 'utf8'));
        expect(written.dependencies.zod).toBe('^4.2.0');
        expect(written.devDependencies?.zod).toBeUndefined();
    });
});

describe('zod range upper bounds at the major boundary', () => {
    it('accepts inclusive bare-major upper bounds that admit 4.x', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '<=4' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('accepts hyphen ranges whose upper bound is a bare 4', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '3.25.0 - 4' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings).toBeUndefined();
    });

    it('still warns on exclusive <4 upper bounds', () => {
        writeJson('package.json', {
            name: 'app',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0', zod: '>=3.25 <4' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('floor');
    });
});

describe('injected zod in manifests that never declared the v1 SDK', () => {
    it('adds and applies zod for the nearest non-v1 manifest', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/server': '^2.0.0-alpha.3' } });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(
            manifests,
            new Map(),
            false,
            new Map([[manifests[0]!.path, [path.join(dir, 'src', 'server.ts')]]])
        );
        expect(changes).toHaveLength(1);
        expect(changes[0]!.added).toEqual(['zod']);
        expect(changes[0]!.applied).toBe(true);
        const written = JSON.parse(readFileSync(manifests[0]!.path, 'utf8'));
        expect(written.dependencies.zod).toBe('^4.2.0');
    });

    it('reports without writing in dry-run mode', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/server': '^2.0.0-alpha.3' } });
        const manifests = discoverManifests(dir);
        const before = readFileSync(manifests[0]!.path, 'utf8');
        const changes = updatePackageJson(
            manifests,
            new Map(),
            true,
            new Map([[manifests[0]!.path, [path.join(dir, 'src', 'server.ts')]]])
        );
        expect(changes[0]!.added).toEqual(['zod']);
        expect(readFileSync(manifests[0]!.path, 'utf8')).toBe(before);
    });
});

describe('absolute --ignore glob patterns (review round 3)', () => {
    it('honors absolute patterns containing wildcards', () => {
        writeJson('package.json', { name: 'app', dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' } });
        mkdirSync(path.join(dir, 'src', 'legacy'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'index.ts'), `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n`);
        writeFileSync(path.join(dir, 'src', 'legacy', 'old.ts'), `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n`);

        const result = run(v1ToV2Migration, { targetDir: dir, dryRun: true, ignore: [path.join(dir, 'src', 'legacy', '**')] });
        const touched = result.fileResults.map(fileResult => fileResult.filePath);
        expect(touched.some(filePath => filePath.endsWith('src/index.ts'))).toBe(true);
        expect(touched.some(filePath => filePath.includes('legacy'))).toBe(false);
    });
});

describe('workspace member discovery scope', () => {
    it('ignores workspace globs that resolve outside the target root', () => {
        const outside = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-outside-'));
        try {
            mkdirSync(path.join(outside, 'stray'), { recursive: true });
            writeFileSync(path.join(outside, 'stray', 'package.json'), JSON.stringify({ name: 'stray' }));
            mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
            writeJson('package.json', {
                name: 'root',
                workspaces: ['packages/*', path.join(outside, '*')],
                dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
            });
            writeJson('packages/api/package.json', { name: 'api' });

            const manifests = discoverManifests(dir);
            const dirs = manifests.map(manifest => manifest.dir);
            expect(dirs.some(memberDir => memberDir.includes('packages/api'))).toBe(true);
            expect(dirs.some(memberDir => memberDir.includes('stray'))).toBe(false);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });
});

describe('peer-declared zod (review)', () => {
    it('warns on a peer-only zod range below the floor', () => {
        writeJson('package.json', {
            name: 'lib',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' },
            peerDependencies: { zod: '^3.25.0' }
        });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(manifests, new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]), false);
        expect(changes[0]!.warnings?.[0]).toContain('floor');
    });

    it('does not add a direct zod dependency when zod is declared as a peer', () => {
        writeJson('package.json', {
            name: 'lib',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' },
            peerDependencies: { zod: '^4.2.0' }
        });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        const manifests = discoverManifests(dir);
        const changes = updatePackageJson(
            manifests,
            new Map([[manifests[0]!.path, new Set(['@modelcontextprotocol/server'])]]),
            false,
            new Map([[manifests[0]!.path, [path.join(dir, 'src', 'server.ts')]]])
        );
        expect(changes[0]!.added).not.toContain('zod');
        const written = JSON.parse(readFileSync(manifests[0]!.path, 'utf8'));
        expect(written.dependencies.zod).toBeUndefined();
        expect(written.devDependencies?.zod).toBeUndefined();
    });
});
