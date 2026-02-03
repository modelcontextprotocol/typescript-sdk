/**
 * Deno runtime integration test
 *
 * This test verifies that the MCP server package works in Deno runtime
 * by creating an MCP server and registering tools.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const DENO_PORT = 8789;
const TEST_TIMEOUT = 120000;

describe('Deno runtime compatibility', () => {
    let denoProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        // Check if Deno is installed
        try {
            execSync('deno --version', { stdio: 'pipe' });
        } catch {
            console.log('Deno is not installed, skipping test');
            return;
        }

        // Create temp directory for the test project
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deno-mcp-test-'));

        // Get the path to the server package
        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');

        // Pack the server package to get a proper tarball (pnpm pack resolves catalog: deps)
        const packOutput = execSync('pnpm pack --pack-destination ' + tempDir, {
            cwd: serverPkgPath,
            encoding: 'utf-8',
        });

        // Find the tarball path (last line of output)
        const tarballPath = packOutput.trim().split('\n').pop()!;
        const tarballName = path.basename(tarballPath);

        // Create package.json pointing to the tarball
        const pkgJson = {
            name: 'deno-mcp-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1',
                ajv: '^8.17.1',
                'ajv-formats': '^3.0.1',
            },
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        // Create server source - tests MCP server creation and tool registration
        const serverSource = `
import { McpServer } from "@modelcontextprotocol/server";

const PORT = ${DENO_PORT};

console.log('Server starting on port', PORT);

Deno.serve({ port: PORT }, async (request) => {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', runtime: 'deno', version: Deno.version.deno }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Test MCP server creation and tool registration
    if (url.pathname === '/test') {
        try {
            const mcpServer = new McpServer({ name: 'deno-test-server', version: '1.0.0' });

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
                serverName: 'deno-test-server',
                toolRegistered: true,
                runtime: 'deno'
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
});
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource.trim());

        // Create deno.json configuration to use node_modules with "byonm" (bring your own node_modules)
        const denoConfig = {
            nodeModulesDir: 'manual',
            unstable: ['byonm'],
        };
        fs.writeFileSync(path.join(tempDir, 'deno.json'), JSON.stringify(denoConfig, null, 2));

        // Install dependencies using npm (Deno will read from node_modules)
        try {
            execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60000 });
        } catch (error) {
            console.error('npm install failed:', error);
            throw error;
        }

        // Start Deno server with necessary permissions
        denoProcess = spawn(
            'deno',
            ['run', '--allow-net', '--allow-read', '--allow-env', 'server.ts'],
            {
                cwd: tempDir,
                shell: true,
                stdio: 'pipe',
            }
        );

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Deno startup timeout')), 60000);

            let stdoutData = '';
            let stderrData = '';

            denoProcess!.stdout?.on('data', (data) => {
                stdoutData += data.toString();
                if (stdoutData.includes('Server starting on port') || stdoutData.includes('Listening on')) {
                    clearTimeout(timeout);
                    setTimeout(resolve, 2000);
                }
            });

            denoProcess!.stderr?.on('data', (data) => {
                stderrData += data.toString();
            });

            denoProcess!.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            denoProcess!.on('close', (code) => {
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
            await new Promise<void>((resolve) => {
                denoProcess!.on('close', () => resolve());
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

    it('should create MCP server and register tools in Deno', async () => {
        // Check if Deno is installed
        try {
            execSync('deno --version', { stdio: 'pipe' });
        } catch {
            console.log('Deno is not installed, skipping test');
            return;
        }

        // Check health endpoint
        const healthResponse = await fetch(`http://127.0.0.1:${DENO_PORT}/health`);
        expect(healthResponse.ok).toBe(true);
        const health = await healthResponse.json() as { status: string; runtime: string };
        expect(health.status).toBe('ok');
        expect(health.runtime).toBe('deno');

        // Test MCP server creation and tool registration
        const testResponse = await fetch(`http://127.0.0.1:${DENO_PORT}/test`);
        expect(testResponse.ok).toBe(true);

        const result = await testResponse.json() as {
            success: boolean;
            serverName: string;
            toolRegistered: boolean;
            runtime: string;
        };

        expect(result.success).toBe(true);
        expect(result.serverName).toBe('deno-test-server');
        expect(result.toolRegistered).toBe(true);
        expect(result.runtime).toBe('deno');
    });
});
