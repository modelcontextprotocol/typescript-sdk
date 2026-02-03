/**
 * Bun runtime integration test
 *
 * Verifies the MCP server package works in Bun runtime.
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER_PORT = 8790;
const TEST_TIMEOUT = 120_000;

describe('Bun runtime compatibility', () => {
    let bunProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        try {
            execSync('bun --version', { stdio: 'pipe' });
        } catch {
            console.log('Bun is not installed, skipping test');
            return;
        }

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-runtime-test-'));

        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');
        const packOutput = execSync('pnpm pack --pack-destination ' + tempDir, {
            cwd: serverPkgPath,
            encoding: 'utf8'
        });
        const tarballName = path.basename(packOutput.trim().split('\n').pop()!);

        const pkgJson = {
            name: 'bun-runtime-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1',
                ajv: '^8.17.1',
                'ajv-formats': '^3.0.1'
            }
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        const serverSource = `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'bun-test-server', version: '1.0.0' });

server.registerTool('greet', {
    description: 'Greet someone',
    inputSchema: { name: { type: 'string' } }
}, async ({ name }) => ({
    content: [{ type: 'text', text: 'Hello, ' + name + '!' }]
}));

const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);

Bun.serve({
    port: ${SERVER_PORT},
    fetch: (request) => transport.handleRequest(request)
});

console.log('Bun server listening on port ${SERVER_PORT}');
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource.trim());

        execSync('bun install', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

        bunProcess = spawn('bun', ['run', 'server.ts'], {
            cwd: tempDir,
            stdio: 'pipe'
        });

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Bun server startup timeout')), 30_000);
            let stderrData = '';

            bunProcess!.stdout?.on('data', data => {
                if (data.toString().includes('listening on port')) {
                    clearTimeout(timeout);
                    setTimeout(resolve, 500);
                }
            });

            bunProcess!.stderr?.on('data', data => {
                stderrData += data.toString();
            });

            bunProcess!.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            bunProcess!.on('close', code => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Bun server exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (bunProcess) {
            bunProcess.kill('SIGTERM');
            await new Promise<void>(resolve => {
                bunProcess!.on('close', () => resolve());
                setTimeout(resolve, 5000);
            });
        }
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        }
    });

    it('should handle MCP requests', async () => {
        try {
            execSync('bun --version', { stdio: 'pipe' });
        } catch {
            console.log('Bun is not installed, skipping test');
            return;
        }

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/`));

        await client.connect(transport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);

        await client.close();
    });
});
