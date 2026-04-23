import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { getMigration } from '../src/migrations/index.js';
import { run } from '../src/runner.js';
import { DiagnosticLevel } from '../src/types.js';

const migration = getMigration('v1-to-v2')!;

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

        // Symbol renames
        expect(output).toContain('NodeStreamableHTTPServerTransport');
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
