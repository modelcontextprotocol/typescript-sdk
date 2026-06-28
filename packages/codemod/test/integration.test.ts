import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { getMigration } from '../src/migrations/index';
import { run } from '../src/runner';
import { DiagnosticLevel } from '../src/types';
import type { Migration, Transform } from '../src/types';

const migration = getMigration('v1-to-v2')!;

function writePkgJson(dir: string, content: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(content, null, 2) + '\n');
}

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-test-'));
    return tempDir;
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('integration', () => {
    it('applies all transforms to a realistic v1 file', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { CallToolRequestSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            ``,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            `const transport = new StreamableHTTPServerTransport({});`,
            ``,
            `server.tool('greet', 'Say hello', { name: z.string() }, async ({ name }, extra) => {`,
            `    const s = extra.signal;`,
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ``,
            `server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {`,
            `    const id = extra.requestId;`,
            `    return { content: [] };`,
            `});`,
            ``,
            `const code = ErrorCode.InvalidParams;`,
            `const timeout = ErrorCode.RequestTimeout;`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBe(1);
        expect(result.totalChanges).toBeGreaterThan(0);

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');

        // Import paths rewritten
        expect(output).toContain('@modelcontextprotocol/server');
        expect(output).toContain('@modelcontextprotocol/node');
        expect(output).not.toContain('@modelcontextprotocol/sdk');

        // Symbol renames + body references updated
        expect(output).toContain('NodeStreamableHTTPServerTransport');
        expect(output).toContain('new NodeStreamableHTTPServerTransport({})');
        expect(output).not.toMatch(/(?<!Node)StreamableHTTPServerTransport/);
        expect(output).toContain('ProtocolErrorCode.InvalidParams');
        expect(output).toContain('SdkErrorCode.RequestTimeout');

        // McpServer API migration
        expect(output).toContain('registerTool');
        expect(output).not.toMatch(/server\.tool\(/);

        // Handler registration
        expect(output).toContain("setRequestHandler('tools/call'");
        expect(output).not.toContain('CallToolRequestSchema');

        // Context rewrites
        expect(output).toContain('ctx.mcpReq.signal');
        expect(output).toContain('ctx.mcpReq.id');
        expect(output).not.toContain('extra');
    });

    it('preserves a leading #! shebang on a migrated file', () => {
        // Regression: the imports transform consumed the line-1 shebang (leading trivia of the first
        // import), silently breaking CLI packages whose `bin` points at the compiled entry.
        const dir = createTempDir();
        const input = [
            `#!/usr/bin/env node`,
            ``,
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'cli.ts'), input);

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBe(1);

        const output = readFileSync(path.join(dir, 'cli.ts'), 'utf8');
        // Imports were migrated...
        expect(output).toContain('@modelcontextprotocol/server');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        // ...and the shebang on line 1 — plus the blank line that separated it from the code — must survive.
        expect(output.startsWith('#!/usr/bin/env node\n\n')).toBe(true);
    });

    it('dry-run mode does not modify files', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `server.tool('ping', async () => ({ content: [] }));`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir, dryRun: true });

        expect(result.totalChanges).toBeGreaterThan(0);

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).toBe(input);
    });

    it('skips files with no SDK imports', () => {
        const dir = createTempDir();
        const input = `import express from 'express';\nconst app = express();\n`;

        writeFileSync(path.join(dir, 'app.ts'), input);

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBe(0);
        expect(result.totalChanges).toBe(0);

        const output = readFileSync(path.join(dir, 'app.ts'), 'utf8');
        expect(output).toBe(input);
    });

    it('processes multiple files independently', () => {
        const dir = createTempDir();
        const serverFile = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `server.tool('ping', async () => ({ content: [] }));`,
            ``
        ].join('\n');
        const clientFile = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `const client = new Client({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');
        const plainFile = `const x = 1;\n`;

        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'server.ts'), serverFile);
        writeFileSync(path.join(dir, 'src', 'client.ts'), clientFile);
        writeFileSync(path.join(dir, 'src', 'utils.ts'), plainFile);

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBe(2);

        const serverOutput = readFileSync(path.join(dir, 'src', 'server.ts'), 'utf8');
        expect(serverOutput).toContain('@modelcontextprotocol/server');

        const clientOutput = readFileSync(path.join(dir, 'src', 'client.ts'), 'utf8');
        expect(clientOutput).toContain('@modelcontextprotocol/client');

        const utilsOutput = readFileSync(path.join(dir, 'src', 'utils.ts'), 'utf8');
        expect(utilsOutput).toBe(plainFile);
    });

    it('recovers from transform errors and reports diagnostics', () => {
        const dir = createTempDir();

        // A valid file that should be transformed successfully
        const validFile = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');

        // A file that will trigger the failing transform
        const brokenFile = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'broken', version: '1.0' });`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'valid.ts'), validFile);
        writeFileSync(path.join(dir, 'broken.ts'), brokenFile);

        // Build a custom migration: real transforms + one that throws on 'broken' files
        const failingTransform: Transform = {
            name: 'failing',
            id: 'failing',
            apply(sourceFile) {
                if (sourceFile.getFilePath().includes('broken')) {
                    throw new Error('Intentional failure for error-recovery test');
                }
                return { changesCount: 0, diagnostics: [] };
            }
        };

        const testMigration: Migration = {
            name: 'test-with-failing-transform',
            description: 'Real transforms plus a failing transform for testing error recovery',
            transforms: [...migration.transforms, failingTransform]
        };

        const result = run(testMigration, { targetDir: dir });

        // The valid file should still be transformed correctly
        const validOutput = readFileSync(path.join(dir, 'valid.ts'), 'utf8');
        expect(validOutput).toContain('@modelcontextprotocol/server');
        expect(validOutput).not.toContain('@modelcontextprotocol/sdk');

        // The broken file should be rolled back to its original content
        const brokenOutput = readFileSync(path.join(dir, 'broken.ts'), 'utf8');
        expect(brokenOutput).toBe(brokenFile);

        // An error-level diagnostic should mention the failure
        const errorDiags = result.diagnostics.filter(d => d.level === DiagnosticLevel.Error);
        expect(errorDiags.length).toBeGreaterThanOrEqual(1);
        expect(errorDiags.some(d => d.message.includes('Intentional failure'))).toBe(true);

        // The valid file should count as changed; the broken file should not
        expect(result.filesChanged).toBeGreaterThanOrEqual(1);
    });

    it('rollback on transform error does not leak packages or diagnostics', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
        });

        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');
        writeFileSync(path.join(dir, 'broken.ts'), input);

        const leakyTransform: Transform = {
            name: 'leaky',
            id: 'imports',
            apply(sourceFile) {
                return {
                    changesCount: 1,
                    diagnostics: [
                        { level: DiagnosticLevel.Warning, file: sourceFile.getFilePath(), line: 1, message: 'should not survive rollback' }
                    ],
                    usedPackages: new Set(['@modelcontextprotocol/phantom-pkg'])
                };
            }
        };

        const failingTransform: Transform = {
            name: 'failing',
            id: 'failing',
            apply() {
                throw new Error('boom');
            }
        };

        const testMigration: Migration = {
            name: 'test-rollback',
            description: 'Tests that rollback cleans up all side effects',
            transforms: [leakyTransform, failingTransform]
        };

        const result = run(testMigration, { targetDir: dir });

        // File should be rolled back
        const output = readFileSync(path.join(dir, 'broken.ts'), 'utf8');
        expect(output).toBe(input);

        // Only the error diagnostic should survive — not the warning from the reverted transform
        const warnings = result.diagnostics.filter(d => d.level === DiagnosticLevel.Warning);
        expect(warnings).toHaveLength(0);
        const errors = result.diagnostics.filter(d => d.level === DiagnosticLevel.Error);
        expect(errors).toHaveLength(1);
        expect(errors[0]!.message).toContain('boom');

        // Phantom package from the reverted transform should not leak into package.json
        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.added).not.toContain('@modelcontextprotocol/phantom-pkg');
    });

    it('respects transform filter option', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
            `server.tool('ping', async () => ({ content: [] }));`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.ts'), input);

        run(migration, { targetDir: dir, transforms: ['imports'] });

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        // Import paths should be rewritten
        expect(output).toContain('@modelcontextprotocol/server');
        // But McpServer API should NOT be migrated (mcpserver-api transform was not selected)
        expect(output).toContain("server.tool('ping'");
        // McpError should NOT be renamed (symbols transform was not selected)
        expect(output).toContain('McpError');
    });

    it('applies new transforms (removed APIs, SchemaInput, express middleware)', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer, schemaToJson, IsomorphicHeaders } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import type { SchemaInput } from '@modelcontextprotocol/sdk/types.js';`,
            `import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';`,
            `import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware.js';`,
            ``,
            `type Input = SchemaInput<typeof mySchema>;`,
            `const h: IsomorphicHeaders = {};`,
            `if (error instanceof StreamableHTTPError) {}`,
            `app.use(hostHeaderValidation({ allowedHosts: ['localhost'] }));`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBe(1);

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');

        // SchemaInput rewritten
        expect(output).toContain('StandardSchemaWithJSON.InferInput<typeof mySchema>');
        expect(output).not.toContain('SchemaInput');

        // IsomorphicHeaders replaced with global Headers
        expect(output).toContain('const h: Headers');
        expect(output).not.toContain('IsomorphicHeaders');

        // StreamableHTTPError renamed to SdkHttpError
        expect(output).toContain('instanceof SdkHttpError');
        expect(output).not.toContain('StreamableHTTPError');

        // schemaToJson removed (import gone)
        expect(output).not.toContain('schemaToJson');

        // hostHeaderValidation signature migrated
        expect(output).toContain("hostHeaderValidation(['localhost'])");
        expect(output).not.toContain('allowedHosts');

        // Diagnostics emitted
        expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('updates package.json: removes v1 SDK and adds detected v2 packages', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify(
                {
                    dependencies: {
                        '@modelcontextprotocol/sdk': '^1.0.0',
                        express: '^4.0.0'
                    }
                },
                null,
                2
            ) + '\n'
        );
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
                `const server = new McpServer({ name: 'test', version: '1.0' });`,
                `const transport = new StreamableHTTPServerTransport({});`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/server');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/node');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/server']).toBeDefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/node']).toBeDefined();
        expect(pkgJson.dependencies['express']).toBe('^4.0.0');
    });

    it('package.json: does not add core when every schema import is rewritten away', () => {
        // The dominant v1 pattern: a `*Schema` constant used ONLY as a setRequestHandler first arg.
        // importPaths routes it to @modelcontextprotocol/core (recording the package), but
        // handlerRegistration then rewrites the call to a method string and deletes the now-unused
        // import. No core import survives, so package.json must NOT gain a core dependency.
        const dir = createTempDir();
        writePkgJson(dir, { dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
                `const server = new McpServer({ name: 'test', version: '1.0' });`,
                `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        // The schema usage was rewritten and its import deleted.
        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).toContain("setRequestHandler('tools/call'");
        expect(output).not.toContain('core');

        // So core must not be added; the package actually imported (server) still is.
        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/server');
        expect(result.packageJsonChanges!.added).not.toContain('@modelcontextprotocol/core');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/core']).toBeUndefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/server']).toBeDefined();
    });

    it('package.json: still adds core when a schema import survives as a value', () => {
        // Guard against over-correcting: a schema used as a value (e.g. `.parse(...)`) keeps its import,
        // so core remains a real dependency and must still be added.
        const dir = createTempDir();
        writePkgJson(dir, { dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });
        writeFileSync(
            path.join(dir, 'lib.ts'),
            [
                `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
                `export function parseResult(x: unknown) {`,
                `    return CallToolResultSchema.parse(x);`,
                `}`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        const output = readFileSync(path.join(dir, 'lib.ts'), 'utf8');
        expect(output).toContain('@modelcontextprotocol/core');
        expect(output).toContain('CallToolResultSchema.parse');

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/core');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/core']).toBeDefined();
    });

    it('does not modify package.json in dry-run mode', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });
        writeFileSync(path.join(dir, 'server.ts'), `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`);

        const result = run(migration, { targetDir: dir, dryRun: true });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/server');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBe('^1.0.0');
    });

    it('package.json: client-only project adds only @modelcontextprotocol/client', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
        });
        writeFileSync(
            path.join(dir, 'client.ts'),
            [
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                `const client = new Client({ name: 'test', version: '1.0' });`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/client');
        expect(result.packageJsonChanges!.added).not.toContain('@modelcontextprotocol/server');
        expect(result.packageJsonChanges!.added).not.toContain('@modelcontextprotocol/node');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/client']).toBeDefined();
    });

    it('package.json: client + server project adds both packages', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
        });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(
            path.join(dir, 'src', 'server.ts'),
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `const server = new McpServer({ name: 'test', version: '1.0' });`,
                ``
            ].join('\n')
        );
        writeFileSync(
            path.join(dir, 'src', 'client.ts'),
            [
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                `const client = new Client({ name: 'test', version: '1.0' });`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/server');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/client');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/server']).toBeDefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/client']).toBeDefined();
    });

    it('package.json: express middleware import adds @modelcontextprotocol/express', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
        });
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware.js';`,
                `app.use(hostHeaderValidation({ allowedHosts: ['localhost'] }));`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/express');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/server');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/express']).toBeDefined();
    });

    it('package.json: works when no package.json is present', () => {
        const dir = createTempDir();
        mkdirSync(path.join(dir, '.git'), { recursive: true });
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `const server = new McpServer({ name: 'test', version: '1.0' });`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBe(1);
        expect(result.packageJsonChanges).toBeUndefined();

        const output = readFileSync(path.join(dir, 'server.ts'), 'utf8');
        expect(output).toContain('@modelcontextprotocol/server');
    });

    it('package.json: split import adds both /server and /node', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
        });
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { StreamableHTTPServerTransport, EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
                `const transport = new StreamableHTTPServerTransport({});`,
                `const store: EventStore = {} as any;`,
                ``
            ].join('\n')
        );

        const result = run(migration, { targetDir: dir });

        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.removed).toContain('@modelcontextprotocol/sdk');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/server');
        expect(result.packageJsonChanges!.added).toContain('@modelcontextprotocol/node');

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/server']).toBeDefined();
        expect(pkgJson.dependencies['@modelcontextprotocol/node']).toBeDefined();
    });

    it('selective --transforms symbols does not modify package.json', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });
        writeFileSync(
            path.join(dir, 'server.ts'),
            [`import { McpError } from '@modelcontextprotocol/sdk/types.js';`, `throw new McpError(1, 'e');`, ``].join('\n')
        );

        const result = run(migration, { targetDir: dir, transforms: ['symbols'] });
        expect(result.totalChanges).toBeGreaterThan(0);
        expect(result.packageJsonChanges).toBeUndefined();

        const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        expect(pkgJson.dependencies['@modelcontextprotocol/sdk']).toBe('^1.0.0');
    });

    it('reports packageJsonChanges when only package.json is modified', () => {
        const dir = createTempDir();
        writePkgJson(dir, {
            dependencies: {
                '@modelcontextprotocol/sdk': '^1.0.0'
            }
        });
        mkdirSync(path.join(dir, 'src'), { recursive: true });
        writeFileSync(path.join(dir, 'src', 'utils.ts'), `const x = 1;\n`);
        writeFileSync(path.join(dir, 'already-migrated.ts'), [`import { McpServer } from '@modelcontextprotocol/server';`, ``].join('\n'));

        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(0);
        expect(result.packageJsonChanges).toBeDefined();
        expect(result.packageJsonChanges!.removed).toContain('@modelcontextprotocol/sdk');
    });

    it('emits info diagnostics for legacy-moved imports', () => {
        const dir = createTempDir();
        const input = [
            `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';`,
            `const transport = new SSEServerTransport();`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.some(d => d.level === DiagnosticLevel.Info)).toBe(true);
    });

    it('transform ordering: critical dependencies are maintained', () => {
        const ids = migration.transforms.map(t => t.id);
        expect(ids.indexOf('imports')).toBeLessThan(ids.indexOf('symbols'));
        expect(ids.indexOf('symbols')).toBeLessThan(ids.indexOf('removed-apis'));
        expect(ids.indexOf('mcpserver-api')).toBeLessThan(ids.indexOf('context'));
        expect(ids.at(-1)).toBe('mock-paths');
    });

    it('processes .mts files', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.mts'), input);

        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(1);
        const output = readFileSync(path.join(dir, 'server.mts'), 'utf8');
        expect(output).toContain('@modelcontextprotocol/server');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
    });

    it('processes .js files', () => {
        const dir = createTempDir();
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.js'), input);

        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(1);
        const output = readFileSync(path.join(dir, 'server.js'), 'utf8');
        expect(output).toContain('@modelcontextprotocol/server');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
    });

    it('rewrites InMemoryTransport to server package by default', () => {
        const dir = createTempDir();
        const input = [
            `import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';`,
            `const t = new InMemoryTransport();`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'test-utils.ts'), input);

        const result = run(migration, { targetDir: dir });
        expect(result.filesChanged).toBe(1);

        const output = readFileSync(path.join(dir, 'test-utils.ts'), 'utf8');
        expect(output).toContain('@modelcontextprotocol/server');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(output).toContain('InMemoryTransport');

        const v2Gaps = result.diagnostics.filter(d => d.category === 'v2-gap');
        expect(v2Gaps.length).toBe(0);
    });
});
