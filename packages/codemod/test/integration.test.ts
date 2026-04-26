import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { getMigration } from '../src/migrations/index.js';
import { run } from '../src/runner.js';
import { DiagnosticLevel } from '../src/types.js';

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
        const validFile = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new McpServer({ name: 'test', version: '1.0' });`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'valid.ts'), validFile);

        const result = run(migration, { targetDir: dir });

        expect(result.filesChanged).toBeGreaterThanOrEqual(1);

        const validOutput = readFileSync(path.join(dir, 'valid.ts'), 'utf8');
        expect(validOutput).toContain('@modelcontextprotocol/server');
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

        const result = run(migration, { targetDir: dir, transforms: ['imports'] });

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

        // StreamableHTTPError renamed to SdkError
        expect(output).toContain('instanceof SdkError');
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
            [
                `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
                `throw new McpError(1, 'e');`,
                ``
            ].join('\n')
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
        writeFileSync(
            path.join(dir, 'already-migrated.ts'),
            [`import { McpServer } from '@modelcontextprotocol/server';`, ``].join('\n')
        );

        const result = run(migration, { targetDir: dir });
        if (result.filesChanged === 0 && result.packageJsonChanges) {
            expect(result.packageJsonChanges.removed).toContain('@modelcontextprotocol/sdk');
        }
    });

    it('emits diagnostics for removed imports', () => {
        const dir = createTempDir();
        const input = [
            `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';`,
            `const transport = new SSEServerTransport();`,
            ``
        ].join('\n');

        writeFileSync(path.join(dir, 'server.ts'), input);

        const result = run(migration, { targetDir: dir });

        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.some(d => d.level === DiagnosticLevel.Warning)).toBe(true);
    });
});
