/**
 * Bun runtime integration test
 *
 * This test verifies that the MCP server package works in Bun runtime
 * by creating an MCP server and registering tools.
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER_PORT = 8790;
const TEST_TIMEOUT = 120_000;

describe('Bun runtime compatibility', () => {
    let bunProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        // Check if bun is available
        try {
            execSync('bun --version', { stdio: 'pipe' });
        } catch {
            console.log('Bun is not installed, skipping test');
            return;
        }

        // Create temp directory for the test project
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-runtime-test-'));

        // Get the path to the server package
        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');

        // Pack the server package to get a proper tarball (pnpm pack resolves catalog: deps)
        const packOutput = execSync('pnpm pack --pack-destination ' + tempDir, {
            cwd: serverPkgPath,
            encoding: 'utf8'
        });

        // Find the tarball path (last line of output)
        const tarballPath = packOutput.trim().split('\n').pop()!;
        const tarballName = path.basename(tarballPath);

        // Create package.json pointing to the tarball
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

        // Create server source - tests MCP server creation and tool registration
        const serverSource = `
import { McpServer } from '@modelcontextprotocol/server';

const server = Bun.serve({
    port: ${SERVER_PORT},
    async fetch(request) {
        const url = new URL(request.url);

        // Health check endpoint
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok', runtime: 'bun', version: Bun.version }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Test MCP server creation and tool registration
        if (url.pathname === '/test') {
            try {
                const mcpServer = new McpServer({ name: 'bun-test-server', version: '1.0.0' });

                // Register a tool to verify the full registration flow works
                mcpServer.registerTool('greet', {
                    description: 'Greet someone by name',
                    inputSchema: {
                        name: { type: 'string', description: 'Name to greet' }
                    }
                }, async ({ name }) => {
                    return {
                        content: [{ type: 'text', text: 'Hello, ' + name + '!' }]
                    };
                });

                return new Response(JSON.stringify({
                    success: true,
                    serverName: 'bun-test-server',
                    toolRegistered: true,
                    runtime: 'bun'
                }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (error) {
                return new Response(JSON.stringify({
                    success: false,
                    error: error.message
                }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        return new Response('Not Found', { status: 404 });
    },
});

console.log('Bun server listening on port ' + server.port);
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource.trim());

        // Install dependencies using bun
        try {
            execSync('bun install', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });
        } catch (error) {
            console.error('bun install failed:', error);
            throw error;
        }

        // Start bun server
        bunProcess = spawn('bun', ['run', 'server.ts'], {
            cwd: tempDir,
            stdio: 'pipe'
        });

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Bun server startup timeout')), 30_000);

            let stdoutData = '';
            let stderrData = '';

            bunProcess!.stdout?.on('data', data => {
                stdoutData += data.toString();
                if (stdoutData.includes('listening on port')) {
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

        // Cleanup temp directory
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        }
    });

    it('should create MCP server and register tools in Bun', async () => {
        // Check if bun is available
        try {
            execSync('bun --version', { stdio: 'pipe' });
        } catch {
            console.log('Bun is not installed, skipping test');
            return;
        }

        // Check health endpoint
        const healthResponse = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`);
        expect(healthResponse.ok).toBe(true);
        const health = (await healthResponse.json()) as { status: string; runtime: string };
        expect(health.status).toBe('ok');
        expect(health.runtime).toBe('bun');

        // Test MCP server creation and tool registration
        const testResponse = await fetch(`http://127.0.0.1:${SERVER_PORT}/test`);
        expect(testResponse.ok).toBe(true);

        const result = (await testResponse.json()) as {
            success: boolean;
            serverName: string;
            toolRegistered: boolean;
            runtime: string;
        };

        expect(result.success).toBe(true);
        expect(result.serverName).toBe('bun-test-server');
        expect(result.toolRegistered).toBe(true);
        expect(result.runtime).toBe('bun');
    });
});
