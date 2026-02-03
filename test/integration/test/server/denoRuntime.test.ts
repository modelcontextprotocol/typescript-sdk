/**
 * Deno runtime integration test
 *
 * Verifies the MCP server package works in Deno runtime.
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DENO_PORT = 8789;
const TEST_TIMEOUT = 120_000;

describe('Deno runtime compatibility', () => {
    let denoProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        try {
            execSync('deno --version', { stdio: 'pipe' });
        } catch {
            console.log('Deno is not installed, skipping test');
            return;
        }

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deno-mcp-test-'));

        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');
        const packOutput = execSync('pnpm pack --pack-destination ' + tempDir, {
            cwd: serverPkgPath,
            encoding: 'utf8'
        });
        const tarballName = path.basename(packOutput.trim().split('\n').pop()!);

        const pkgJson = {
            name: 'deno-mcp-test',
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
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

const server = new McpServer({ name: "deno-test-server", version: "1.0.0" });

server.registerTool("greet", {
    description: "Greet someone",
    inputSchema: { name: { type: "string" } }
}, async ({ name }) => ({
    content: [{ type: "text", text: "Hello, " + name + "!" }]
}));

const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);

console.log("Deno server listening on port ${DENO_PORT}");

Deno.serve({ port: ${DENO_PORT} }, (request) => transport.handleRequest(request));
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource.trim());

        const denoConfig = {
            nodeModulesDir: 'manual',
            unstable: ['byonm']
        };
        fs.writeFileSync(path.join(tempDir, 'deno.json'), JSON.stringify(denoConfig, null, 2));

        execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

        denoProcess = spawn('deno', ['run', '--allow-net', '--allow-read', '--allow-env', 'server.ts'], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe'
        });

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Deno startup timeout')), 60_000);
            let stderrData = '';

            denoProcess!.stdout?.on('data', data => {
                if (data.toString().includes('listening on port') || data.toString().includes('Listening on')) {
                    clearTimeout(timeout);
                    setTimeout(resolve, 2000);
                }
            });

            denoProcess!.stderr?.on('data', data => {
                stderrData += data.toString();
            });

            denoProcess!.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            denoProcess!.on('close', code => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Deno exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (denoProcess) {
            denoProcess.kill('SIGTERM');
            await new Promise<void>(resolve => {
                denoProcess!.on('close', () => resolve());
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
            execSync('deno --version', { stdio: 'pipe' });
        } catch {
            console.log('Deno is not installed, skipping test');
            return;
        }

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${DENO_PORT}/`));

        await client.connect(transport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);

        await client.close();
    });
});
