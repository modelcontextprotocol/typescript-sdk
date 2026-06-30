import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { analyzeProject, resolveTypesPackage } from '../src/utils/projectAnalyzer';

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-analyzer-'));
    return tempDir;
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('analyzeProject', () => {
    it('returns unknown when no package.json exists', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, '.git'), { recursive: true });
        mkdirSync(path.join(dir, 'src'), { recursive: true });

        const result = analyzeProject(path.join(dir, 'src'));
        expect(result.projectType).toBe('unknown');
    });

    it('finds package.json in parent directory', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/client': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'src'));
        expect(result.projectType).toBe('client');
    });

    it('finds package.json multiple levels up', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'src', 'lib', 'utils'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/server': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'src', 'lib', 'utils'));
        expect(result.projectType).toBe('server');
    });

    it('stops walking at .git boundary', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'project', 'src'), { recursive: true });
        mkdirSync(path.join(dir, 'project', '.git'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/client': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'project', 'src'));
        expect(result.projectType).toBe('unknown');
    });

    it('stops walking at node_modules boundary', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, 'project', 'src'), { recursive: true });
        mkdirSync(path.join(dir, 'project', 'node_modules'), { recursive: true });
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/client': '^2.0.0' }
            })
        );

        const result = analyzeProject(path.join(dir, 'project', 'src'));
        expect(result.projectType).toBe('unknown');
    });

    it('detects both client and server dependencies', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: {
                    '@modelcontextprotocol/client': '^2.0.0',
                    '@modelcontextprotocol/server': '^2.0.0'
                }
            })
        );

        const result = analyzeProject(dir);
        expect(result.projectType).toBe('both');
    });

    it('finds package.json at targetDir itself', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/server': '^2.0.0' }
            })
        );

        const result = analyzeProject(dir);
        expect(result.projectType).toBe('server');
    });

    it('returns unknown for a v1 SDK package with no source signal', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
            })
        );

        const result = analyzeProject(dir);
        expect(result.projectType).toBe('unknown');
    });

    describe('source inference for v1 (pre-split) projects', () => {
        function v1Project(files: Record<string, string>): string {
            const dir = createTempDir();
            writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }));
            mkdirSync(path.join(dir, 'src'), { recursive: true });
            for (const [name, content] of Object.entries(files)) {
                writeFileSync(path.join(dir, 'src', name), content);
            }
            return dir;
        }

        it('infers client from sdk/client subpath usage', () => {
            const dir = v1Project({ 'a.ts': `import { Client } from '@modelcontextprotocol/sdk/client/index.js';` });
            expect(analyzeProject(dir).projectType).toBe('client');
        });

        it('infers server from sdk/server subpath usage', () => {
            const dir = v1Project({ 'a.ts': `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';` });
            expect(analyzeProject(dir).projectType).toBe('server');
        });

        it('infers both when client and server subpaths are used across files', () => {
            const dir = v1Project({
                'client.ts': `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                'server.ts': `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`
            });
            expect(analyzeProject(dir).projectType).toBe('both');
        });

        it('infers from an extensionless / bare sdk subpath specifier', () => {
            const dir = v1Project({ 'a.ts': `import { McpServer } from '@modelcontextprotocol/sdk/server';` });
            expect(analyzeProject(dir).projectType).toBe('server');
        });

        it('stays unknown when only shared paths are imported', () => {
            const dir = v1Project({ 'a.ts': `import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';` });
            expect(analyzeProject(dir).projectType).toBe('unknown');
        });

        it('ignores an import path that appears only in a comment (not a quoted specifier)', () => {
            // A real client import plus a comment mentioning the server subpath. A whole-file substring
            // scan would flip this to "both"; the quote-anchored match keeps it "client".
            const dir = v1Project({
                'a.ts': [
                    `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                    `// previously imported from @modelcontextprotocol/sdk/server/mcp.js`,
                    ''
                ].join('\n')
            });
            expect(analyzeProject(dir).projectType).toBe('client');
        });

        it('infers from source even without a package.json', () => {
            const dir = createTempDir();
            mkdirSync(path.join(dir, 'src'), { recursive: true });
            writeFileSync(path.join(dir, 'src', 'a.ts'), `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`);
            expect(analyzeProject(path.join(dir, 'src')).projectType).toBe('client');
        });

        it('ignores node_modules when scanning source', () => {
            const dir = v1Project({ 'a.ts': `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';` });
            mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
            writeFileSync(
                path.join(dir, 'node_modules', 'pkg', 'index.ts'),
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`
            );
            // Only the server import in src counts; the client import under node_modules is skipped.
            expect(analyzeProject(dir).projectType).toBe('server');
        });
    });
});

describe('resolveTypesPackage', () => {
    it('emits an info note (not a warning) for a both-project ambiguous file', () => {
        const sink = { filePath: 'f.ts', line: 1, diagnostics: [] as import('../src/types').Diagnostic[] };
        const target = resolveTypesPackage({ projectType: 'both' }, false, false, sink);
        expect(target).toBe('@modelcontextprotocol/server');
        expect(sink.diagnostics).toHaveLength(1);
        expect(sink.diagnostics[0]!.level).toBe('info');
    });

    it('emits an action-required warning for a genuinely unknown project', () => {
        const sink = { filePath: 'f.ts', line: 1, diagnostics: [] as import('../src/types').Diagnostic[] };
        resolveTypesPackage({ projectType: 'unknown' }, false, false, sink);
        expect(sink.diagnostics).toHaveLength(1);
        expect(sink.diagnostics[0]!.level).toBe('warning');
    });

    it('resolves by per-file signal regardless of project type', () => {
        expect(resolveTypesPackage({ projectType: 'both' }, true, false)).toBe('@modelcontextprotocol/client');
        expect(resolveTypesPackage({ projectType: 'unknown' }, false, true)).toBe('@modelcontextprotocol/server');
    });
});

describe('analyzeProject moduleSystem', () => {
    function setup(files: Record<string, string>): string {
        const dir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-mod-'));
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        for (const [rel, content] of Object.entries(files)) {
            writeFileSync(path.join(dir, rel), content);
        }
        return dir;
    }

    it('package.json type:module => esm', () => {
        const dir = setup({ 'package.json': JSON.stringify({ type: 'module' }) });
        expect(analyzeProject(path.join(dir, 'src')).moduleSystem).toBe('esm');
        rmSync(dir, { recursive: true, force: true });
    });

    it('tsconfig module:commonjs, no type => commonjs', () => {
        const dir = setup({
            'package.json': JSON.stringify({}),
            'tsconfig.json': '{ "compilerOptions": { "module": "commonjs" } } // jsonc ok'
        });
        expect(analyzeProject(path.join(dir, 'src')).moduleSystem).toBe('commonjs');
        rmSync(dir, { recursive: true, force: true });
    });

    it('tsconfig module:nodenext, no type => commonjs', () => {
        const dir = setup({
            'package.json': JSON.stringify({}),
            'tsconfig.json': '{ "compilerOptions": { "module": "nodenext" } }'
        });
        expect(analyzeProject(path.join(dir, 'src')).moduleSystem).toBe('commonjs');
        rmSync(dir, { recursive: true, force: true });
    });

    it('tsconfig module:esnext => esm', () => {
        const dir = setup({
            'package.json': JSON.stringify({}),
            'tsconfig.json': '{ "compilerOptions": { "module": "esnext" } }'
        });
        expect(analyzeProject(path.join(dir, 'src')).moduleSystem).toBe('esm');
        rmSync(dir, { recursive: true, force: true });
    });

    it('no package.json and no tsconfig => unknown', () => {
        const dir = setup({});
        mkdirSync(path.join(dir, '.git'), { recursive: true });
        expect(analyzeProject(path.join(dir, 'src')).moduleSystem).toBe('unknown');
        rmSync(dir, { recursive: true, force: true });
    });
});
