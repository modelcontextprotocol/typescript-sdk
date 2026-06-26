import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getMigration } from '../../src/migrations/index';
import { run } from '../../src/runner';
import { DiagnosticLevel } from '../../src/types';

const migration = getMigration('v1-to-v2')!;

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-rw-'));
    return tempDir;
}

function writePkgJson(dir: string, content: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(content, null, 2) + '\n');
}

afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// ─── #165: ELOOP on pnpm symlink cycles; --ignore not honoured during descent ──────────────────────

describe('#165 — directory walk skips symlinks and prunes ignored dirs', () => {
    it('does not follow a cyclic node_modules symlink (pnpm intra-workspace dep cycle)', () => {
        const dir = createTempDir();
        // packages/a/node_modules/@scope/b → ../../b ; packages/b/node_modules/@scope/a → ../../a
        for (const name of ['a', 'b']) {
            mkdirSync(path.join(dir, 'packages', name, 'node_modules', '@scope'), { recursive: true });
            writePkgJson(path.join(dir, 'packages', name), {
                name: `@scope/${name}`,
                dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
            });
            writeFileSync(
                path.join(dir, 'packages', name, 'index.ts'),
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`
            );
        }
        symlinkSync(path.join(dir, 'packages', 'b'), path.join(dir, 'packages', 'a', 'node_modules', '@scope', 'b'), 'dir');
        symlinkSync(path.join(dir, 'packages', 'a'), path.join(dir, 'packages', 'b', 'node_modules', '@scope', 'a'), 'dir');

        // Would previously die with ELOOP inside ts-morph's glob.
        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(2);
    });

    it('honours --ignore during directory descent (a cyclic-symlink dir matched by --ignore is never entered)', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'vendor', 'loop'), { recursive: true });
        symlinkSync(path.join(dir, 'vendor'), path.join(dir, 'vendor', 'loop', 'back'), 'dir');
        writeFileSync(path.join(dir, 'index.ts'), `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n`);
        writePkgJson(dir, { dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });

        const result = run(migration, { targetDir: dir, ignore: ['**/vendor/**'] });
        expect(result.filesChanged).toBe(1);
    });
});

// ─── #150: workspace-member package.json files are updated ─────────────────────────────────────────

describe('#150 — pnpm workspace member manifests are updated', () => {
    it('updates every workspace member that depends on the v1 SDK, attributing per-package usage', () => {
        const dir = createTempDir();
        // Workspace root has no SDK dep — should be left alone.
        writePkgJson(dir, { name: 'root', private: true, workspaces: ['packages/*'] });
        mkdirSync(path.join(dir, 'packages', 'svc'), { recursive: true });
        mkdirSync(path.join(dir, 'packages', 'cli'), { recursive: true });
        writePkgJson(path.join(dir, 'packages', 'svc'), {
            name: 'svc',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        writePkgJson(path.join(dir, 'packages', 'cli'), {
            name: 'cli',
            dependencies: { '@modelcontextprotocol/sdk': '^1.29.0' }
        });
        writeFileSync(
            path.join(dir, 'packages', 'svc', 'index.ts'),
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`
        );
        writeFileSync(
            path.join(dir, 'packages', 'cli', 'index.ts'),
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n`
        );

        const result = run(migration, { targetDir: dir });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.length).toBe(2);

        const svc = JSON.parse(readFileSync(path.join(dir, 'packages', 'svc', 'package.json'), 'utf8'));
        const cli = JSON.parse(readFileSync(path.join(dir, 'packages', 'cli', 'package.json'), 'utf8'));
        expect(svc.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(svc.dependencies['@modelcontextprotocol/server']).toBeDefined();
        expect(svc.dependencies['@modelcontextprotocol/client']).toBeUndefined();
        expect(cli.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(cli.dependencies['@modelcontextprotocol/client']).toBeDefined();
        expect(cli.dependencies['@modelcontextprotocol/server']).toBeUndefined();

        // Root manifest has no v1 SDK dep — must not be touched.
        const root = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(root.dependencies).toBeUndefined();
    });
});

// ─── #122: zod v3 range diagnostic + --prefer override ─────────────────────────────────────────────

describe('#122 — zod v3 range is reported (not rewritten); --prefer overrides the unknown-project default', () => {
    it('reports (does NOT rewrite) a zod ^3 range alongside the v1→v2 dependency swap', () => {
        // Bumping the user's Zod major can break their own non-SDK Zod code; the codemod only
        // surfaces the note and leaves the range untouched. The note steers to the two valid paths
        // (bump to ^4, or pin ^3.25+ and import from 'zod/v4').
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', zod: '^3.25.0' }
        });
        writeFileSync(path.join(dir, 'index.ts'), `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`);

        const result = run(migration, { targetDir: dir });
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkg.dependencies['zod']).toBe('^3.25.0');
        const note = result.packageJsonChanges![0]!.notes?.find(n => n.includes('zod'));
        expect(note).toBeDefined();
        expect(note).toContain("'zod/v4'");
        expect(note).toContain('upgrade-to-v2.md');
    });

    it('routes shared types to client when --prefer client is set and no signal is found (info, not warning)', () => {
        const dir = createTempDir();
        // No package.json, no client/server-specific imports — `unknown` project.
        mkdirSync(path.join(dir, '.git'));
        writeFileSync(path.join(dir, 'index.ts'), `import { Progress } from '@modelcontextprotocol/sdk/types.js';\n`);

        const result = run(migration, { targetDir: dir, prefer: 'client' });
        const out = readFileSync(path.join(dir, 'index.ts'), 'utf8');
        expect(out).toContain('@modelcontextprotocol/client');
        expect(result.diagnostics.some(d => d.level === DiagnosticLevel.Warning && d.message.includes('Could not determine'))).toBe(false);
        expect(result.diagnostics.some(d => d.level === DiagnosticLevel.Info && d.message.includes('--prefer client'))).toBe(true);
    });
});

// ─── #164: file-header comment preservation across all transforms ──────────────────────────────────

describe('#164 — leading file-header comments survive the full transform pipeline', () => {
    it('preserves a /** */ header when a later transform removes the rewritten first import', () => {
        // importPaths rewrites the first (and only) SDK import; symbolRenames then removes that import
        // declaration entirely (RequestHandlerExtra is the only specifier) — taking the JSDoc header,
        // which is its leading trivia, with it. The runner-level restore must put the header back.
        const dir = createTempDir();
        const input = [
            `/**`,
            ` * Twenty lines of design documentation about capability negotiation`,
            ` * that must not be silently deleted.`,
            ` */`,
            `import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            ``,
            `export function helper(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): void {}`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'capabilities.ts'), input);

        run(migration, { targetDir: dir });
        const out = readFileSync(path.join(dir, 'capabilities.ts'), 'utf8');
        expect(out.startsWith('/**')).toBe(true);
        expect(out).toContain('design documentation about capability negotiation');
        expect(out).toContain('ServerContext');
    });

    it('keeps a multi-line // header at the top of the file (not displaced below an inserted import)', () => {
        // ts-morph re-attaches the surviving // lines to the next statement and inserts the new import
        // at byte 0, leaving the header below it. The runner-level restore must move it back to the top.
        const dir = createTempDir();
        const header = `// This file wires the HTTP transport. It also explains why\n// session ordering matters across reconnects.\n`;
        const input = header + `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nnew Client({});\n`;
        writeFileSync(path.join(dir, 'http.ts'), input);

        run(migration, { targetDir: dir });
        const out = readFileSync(path.join(dir, 'http.ts'), 'utf8');
        expect(out.startsWith(header)).toBe(true);
        // Exactly one copy of each header line.
        expect(out.split('wires the HTTP transport').length - 1).toBe(1);
        expect(out.split('session ordering matters').length - 1).toBe(1);
    });
});
