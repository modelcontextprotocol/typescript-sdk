import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { getMigration } from '../src/migrations/index.js';
import { run } from '../src/runner.js';
import { DiagnosticLevel } from '../src/types.js';

const migration = getMigration('v1-to-v2')!;

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-cli-'));
    return tempDir;
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('CLI diagnostic behavior', () => {
    it('warnings do not produce errors-level diagnostics', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';`,
                `const transport = new SSEServerTransport();`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        const warnings = result.diagnostics.filter(d => d.level === DiagnosticLevel.Warning);
        const errors = result.diagnostics.filter(d => d.level === DiagnosticLevel.Error);
        expect(warnings.length).toBeGreaterThan(0);
        expect(errors.length).toBe(0);
    });

    it('emits info-level diagnostics for z.object() wrapping', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `const server = new McpServer({ name: 'test', version: '1.0' });`,
                `server.tool('greet', 'Say hello', { name: z.string() }, async ({ name }) => {`,
                `    return { content: [{ type: 'text', text: name }] };`,
                `});`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        const infos = result.diagnostics.filter(d => d.level === DiagnosticLevel.Info);
        expect(infos.length).toBeGreaterThan(0);
        expect(infos.some(d => d.message.includes('z.object'))).toBe(true);
    });
});

describe('--transforms validation', () => {
    it('throws on unknown transform IDs', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'test.ts'), `const x = 1;\n`);

        expect(() => run(migration, { targetDir: dir, transforms: ['import-paths', 'symbol-renames'] })).toThrow(/Unknown transform ID/);
    });

    it('error message lists the unknown IDs and available IDs', () => {
        const dir = createTempDir();
        writeFileSync(path.join(dir, 'test.ts'), `const x = 1;\n`);

        expect(() => run(migration, { targetDir: dir, transforms: ['bogus'] })).toThrow(/bogus.*Available:/);
    });

    it('accepts valid transform IDs', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'test.ts'),
            [`import { McpError } from '@modelcontextprotocol/sdk/types.js';`, `throw new McpError(1, 'e');`, ''].join('\n')
        );

        const result = run(migration, { targetDir: dir, transforms: ['symbols'] });
        expect(result.totalChanges).toBeGreaterThan(0);
    });
});

describe('.d.ts exclusion', () => {
    it('skips .d.ts files', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'types.d.ts'),
            [`import type { McpError } from '@modelcontextprotocol/sdk/types.js';`, `export type E = McpError;`, ''].join('\n')
        );

        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(0);
    });

    it('skips .d.mts files', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'types.d.mts'),
            [`import type { McpError } from '@modelcontextprotocol/sdk/types.js';`, `export type E = McpError;`, ''].join('\n')
        );

        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(0);
    });
});

describe('CLI command declaration', () => {
    it('v1-to-v2 migration is registered and has transforms', () => {
        expect(migration).toBeDefined();
        expect(migration.transforms.length).toBeGreaterThan(0);
    });

    it('all transforms have an id and name', () => {
        for (const t of migration.transforms) {
            expect(t.id).toBeTruthy();
            expect(t.name).toBeTruthy();
        }
    });
});
