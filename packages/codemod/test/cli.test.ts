import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

const CLI_PATH = path.resolve(__dirname, '../dist/cli.mjs');

let tempDir: string;

function createTempDir(): string {
    tempDir = mkdtempSync(path.join(tmpdir(), 'mcp-codemod-cli-'));
    return tempDir;
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    try {
        const stdout = execFileSync('node', [CLI_PATH, ...args], {
            encoding: 'utf8',
            env: { ...process.env, NODE_NO_WARNINGS: '1' }
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (error: unknown) {
        const e = error as { stdout: string; stderr: string; status: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
    }
}

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
    }
});

describe('CLI', () => {
    it('--list works without a target-dir argument', () => {
        const { stdout, exitCode } = runCli(['v1-to-v2', '--list']);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Available transforms');
        expect(stdout).toContain('imports');
    });

    it('errors when target-dir is missing and --list is not set', () => {
        const { stderr, exitCode } = runCli(['v1-to-v2']);
        expect(exitCode).toBe(1);
        expect(stderr).toContain('missing required argument');
    });

    it('exits 0 when only warnings are present (no errors)', () => {
        const dir = createTempDir();
        writeFileSync(
            path.join(dir, 'server.ts'),
            [
                `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';`,
                `const transport = new SSEServerTransport();`,
                ``
            ].join('\n')
        );

        const { stdout, exitCode } = runCli(['v1-to-v2', dir]);
        expect(stdout).toContain('Warning');
        expect(exitCode).toBe(0);
    });

    it('prints info diagnostics', () => {
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

        const { stdout, exitCode } = runCli(['v1-to-v2', dir]);
        expect(stdout).toContain('Info');
        expect(exitCode).toBe(0);
    });
});
