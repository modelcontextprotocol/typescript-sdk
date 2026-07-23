import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { parseArgs, parseCodemodCliOutput, runCodemod, installCommand } from '../src/bin/batchTest';
import { computeResultsDirName, type ResolvedConfig } from '../src/bin/batchTest';
import { parseNpmViewVersion, rewriteToPublishedVersion, cleanSubprocessEnv } from '../src/bin/batchTest';
import { getMigration } from '../src/migrations/index';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('installCommand', () => {
    it('uses plain --ignore-scripts for non-pnpm managers', () => {
        expect(installCommand('npm', { hasOwnPnpmWorkspace: false, packageDirs: ['.'] })).toBe('npm install --ignore-scripts');
        expect(installCommand('yarn', { hasOwnPnpmWorkspace: true, packageDirs: ['packages/a'] })).toBe('yarn install --ignore-scripts');
    });

    it('isolates a pnpm clone with no workspace of its own via --ignore-workspace', () => {
        expect(installCommand('pnpm', { hasOwnPnpmWorkspace: false, packageDirs: ['.'] })).toBe(
            'pnpm install --ignore-scripts --ignore-workspace --no-frozen-lockfile'
        );
    });

    it('respects a pnpm clone that is its own workspace and scopes the install to the target packages', () => {
        const cmd = installCommand('pnpm', { hasOwnPnpmWorkspace: true, packageDirs: ['packages/core', 'packages/mcp'] });
        expect(cmd).not.toContain('--ignore-workspace');
        // braces required: pnpm ignores the `...` on a bare `./dir...` selector (drops workspace deps);
        // `{./dir}...` includes them.
        expect(cmd).toBe(
            'pnpm install --ignore-scripts --no-frozen-lockfile --filter "{./packages/core}..." --filter "{./packages/mcp}..."'
        );
    });

    it('installs the whole workspace (no --filter) when the only target is the clone root', () => {
        expect(installCommand('pnpm', { hasOwnPnpmWorkspace: true, packageDirs: ['.'] })).toBe(
            'pnpm install --ignore-scripts --no-frozen-lockfile'
        );
    });
});

describe('parseArgs', () => {
    it('defaults to local/local with latest codemod version and unset sdk version', () => {
        const opts = parseArgs([]);
        expect(opts.sdk).toBe('local');
        expect(opts.codemod).toBe('local');
        expect(opts.codemodVersion).toBe('latest');
        expect(opts.sdkVersion).toBeUndefined();
    });

    it('accepts both space and equals forms for --sdk/--codemod', () => {
        expect(parseArgs(['--sdk', 'published', '--codemod', 'published']).sdk).toBe('published');
        expect(parseArgs(['--sdk=published', '--codemod=published']).codemod).toBe('published');
    });

    it('parses version overrides', () => {
        const opts = parseArgs([
            '--codemod=published',
            '--codemod-version=2.0.0-alpha.2',
            '--sdk=published',
            '--sdk-version=2.0.0-alpha.1'
        ]);
        expect(opts.codemodVersion).toBe('2.0.0-alpha.2');
        expect(opts.sdkVersion).toBe('2.0.0-alpha.1');
    });

    it('strips a leading -- separator', () => {
        expect(parseArgs(['--', '--sdk=published']).sdk).toBe('published');
    });

    it('throws on an invalid --sdk value', () => {
        expect(() => parseArgs(['--sdk=bogus'])).toThrow(/Invalid --sdk/);
    });

    it('throws on an unknown flag', () => {
        expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/);
    });

    it('warns (does not throw) when a version override is given for a local source', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const opts = parseArgs(['--codemod-version=2.0.0-alpha.2', '--sdk-version=2.0.0-alpha.1']);
        expect(opts.codemod).toBe('local');
        expect(opts.sdk).toBe('local');
        expect(warn).toHaveBeenCalledTimes(2);
    });
});

describe('parseCodemodCliOutput', () => {
    it('parses the Changes line (first number = totalChanges, second = filesChanged)', () => {
        expect(parseCodemodCliOutput('Migrating...\nChanges: 42 across 7 file(s)\n')).toEqual({
            totalChanges: 42,
            filesChanged: 7
        });
    });

    it('returns zeros for the no-changes line', () => {
        expect(parseCodemodCliOutput('No changes needed — code already migrated or no SDK imports found.\n')).toEqual({
            totalChanges: 0,
            filesChanged: 0
        });
    });

    it('returns zeros when neither summary line is present (diagnostics-only run)', () => {
        expect(parseCodemodCliOutput('Errors (2):\n  src/a.ts:1 something\n')).toEqual({
            totalChanges: 0,
            filesChanged: 0
        });
    });
});

function cfg(p: Partial<ResolvedConfig>): ResolvedConfig {
    return {
        codemodSource: 'local',
        sdkSource: 'local',
        codemodVersionSpec: 'latest',
        codemodVersionResolved: null,
        sdkVersionSpec: null,
        sdkVersionResolved: null,
        resultsDir: '',
        ...p
    };
}

describe('computeResultsDirName', () => {
    it('default local/local', () => {
        expect(computeResultsDirName(cfg({}))).toBe('codemod-local__sdk-local');
    });
    it('local codemod, published sdk (resolved for naming)', () => {
        expect(computeResultsDirName(cfg({ sdkSource: 'published', sdkVersionResolved: '2.0.0-alpha.1' }))).toBe(
            'codemod-local__sdk-2.0.0-alpha.1'
        );
    });
    it('published/published with both resolved', () => {
        expect(
            computeResultsDirName(
                cfg({
                    codemodSource: 'published',
                    codemodVersionResolved: '2.0.0-alpha.2',
                    sdkSource: 'published',
                    sdkVersionResolved: '2.0.0-alpha.2'
                })
            )
        ).toBe('codemod-2.0.0-alpha.2__sdk-2.0.0-alpha.2');
    });
    it('published codemod, published sdk with unknown version → sdk-from-codemod', () => {
        expect(
            computeResultsDirName(cfg({ codemodSource: 'published', codemodVersionResolved: '2.0.0-alpha.2', sdkSource: 'published' }))
        ).toBe('codemod-2.0.0-alpha.2__sdk-from-codemod');
    });
    it('published codemod, local sdk', () => {
        expect(computeResultsDirName(cfg({ codemodSource: 'published', codemodVersionResolved: '2.0.0-alpha.2' }))).toBe(
            'codemod-2.0.0-alpha.2__sdk-local'
        );
    });
});

describe('parseNpmViewVersion', () => {
    it('uses a JSON string directly', () => {
        expect(parseNpmViewVersion('"2.0.0-alpha.2"')).toBe('2.0.0-alpha.2');
    });
    it('takes the last (most recently published) entry of a JSON array', () => {
        expect(parseNpmViewVersion('["2.0.0-alpha.1","2.0.0-alpha.2"]')).toBe('2.0.0-alpha.2');
    });
    it('throws on an empty array', () => {
        expect(() => parseNpmViewVersion('[]')).toThrow();
    });
});

describe('rewriteToPublishedVersion', () => {
    let dir: string;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('rewrites only v2 deps to their per-package resolved versions, preserving formatting', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'mcp-batch-rewrite-'));
        const pkgPath = path.join(dir, 'package.json');
        const original =
            '{\n' +
            '  "name": "demo",\n' +
            '  "dependencies": {\n' +
            '    "@modelcontextprotocol/server": "^2.0.0-alpha.0",\n' +
            '    "@modelcontextprotocol/core": "^2.0.0-alpha.0",\n' +
            '    "zod": "^3.0.0"\n' +
            '  },\n' +
            '  "devDependencies": {\n' +
            '    "@modelcontextprotocol/client": "^2.0.0-alpha.0"\n' +
            '  }\n' +
            '}\n';
        writeFileSync(pkgPath, original);

        const count = rewriteToPublishedVersion(pkgPath, {
            '@modelcontextprotocol/server': '2.0.0-alpha.3',
            '@modelcontextprotocol/core': '2.0.0-alpha.1',
            '@modelcontextprotocol/client': '2.0.0-alpha.3'
        });

        expect(count).toBe(3);
        const result = JSON.parse(readFileSync(pkgPath, 'utf8'));
        expect(result.dependencies['@modelcontextprotocol/server']).toBe('2.0.0-alpha.3');
        expect(result.dependencies['@modelcontextprotocol/core']).toBe('2.0.0-alpha.1'); // independent version
        expect(result.devDependencies['@modelcontextprotocol/client']).toBe('2.0.0-alpha.3');
        expect(result.dependencies['zod']).toBe('^3.0.0'); // untouched
        const raw = readFileSync(pkgPath, 'utf8');
        expect(raw.endsWith('\n')).toBe(true); // trailing newline preserved
        expect(raw).toContain('  "name"'); // 2-space indent preserved
    });

    it('returns 0 and leaves the file unwritten when no v2 deps are present', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'mcp-batch-rewrite-'));
        const pkgPath = path.join(dir, 'package.json');
        writeFileSync(pkgPath, '{\n  "dependencies": { "zod": "^3.0.0" }\n}\n');
        expect(rewriteToPublishedVersion(pkgPath, { '@modelcontextprotocol/server': '2.0.0-alpha.3' })).toBe(0);
    });
});

describe('runCodemod (local)', () => {
    let dir: string;
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('runs the in-process codemod and returns structured fields with a diagnostics array', () => {
        dir = mkdtempSync(path.join(tmpdir(), 'mcp-batch-runcodemod-'));
        // Minimal v1 source so the imports transform has something to do.
        writeFileSync(path.join(dir, 'package.json'), '{\n  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" }\n}\n');
        writeFileSync(
            path.join(dir, 'index.ts'),
            "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport const c = Client;\n"
        );
        const migration = getMigration('v1-to-v2')!;
        const outcome = runCodemod('local', { migration, sourceDir: dir, codemodVersion: 'unused' });
        expect(Array.isArray(outcome.diagnostics)).toBe(true);
        expect(typeof outcome.filesChanged).toBe('number');
        expect(typeof outcome.totalChanges).toBe('number');
        // The fixture has a real v1 import, so the in-process migration must actually change at least one file.
        expect(outcome.filesChanged).toBeGreaterThanOrEqual(1);
        expect(outcome.cli).toBeUndefined(); // local mode has no CLI capture
    });
});

describe('cleanSubprocessEnv', () => {
    it('strips npm_* and pnpm_* vars (which break npx under pnpm) but preserves everything else', () => {
        const result = cleanSubprocessEnv({
            PATH: '/usr/bin',
            HOME: '/home/x',
            npm_config_frozen_lockfile: 'true',
            npm_config_registry: 'https://registry.example',
            npm_execpath: '/path/to/pnpm.cjs',
            PNPM_HOME: '/pnpm',
            CI: 'false'
        });
        // preserved
        expect(result.PATH).toBe('/usr/bin');
        expect(result.HOME).toBe('/home/x');
        expect(result.CI).toBe('false');
        // stripped — these are what confuse the npx subprocess into "command not found" (exit 127)
        expect(result.npm_config_frozen_lockfile).toBeUndefined();
        expect(result.npm_config_registry).toBeUndefined();
        expect(result.npm_execpath).toBeUndefined();
        expect(result.PNPM_HOME).toBeUndefined();
    });
});
