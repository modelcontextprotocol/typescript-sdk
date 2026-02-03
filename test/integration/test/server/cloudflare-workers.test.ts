/**
 * Cloudflare Workers integration test
 *
 * This test verifies that the MCP server package works in Cloudflare Workers
 * WITHOUT the nodejs_compat flag, using runtime shims for cross-platform compatibility.
 *
 * See also: deno-runtime.test.ts, bun-runtime.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const WORKER_PORT = 8787;
const TEST_TIMEOUT = 120000;

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let wranglerProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        // Create temp directory for the test worker
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-test-'));

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
            name: 'cf-worker-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1',
            },
            devDependencies: {
                wrangler: '^4.0.0',
            },
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        // Create wrangler.jsonc WITHOUT nodejs_compat
        const wranglerConfig = {
            $schema: 'node_modules/wrangler/config-schema.json',
            name: 'cf-worker-test',
            main: 'src/index.js',
            compatibility_date: '2026-02-03',
            // NOTE: nodejs_compat is intentionally NOT included
            // The MCP server should work with runtime shims that use Web APIs
        };
        fs.writeFileSync(
            path.join(tempDir, 'wrangler.jsonc'),
            JSON.stringify(wranglerConfig, null, 2) +
                '\n// nodejs_compat is intentionally NOT included to verify Web API shims work\n'
        );

        // Create src directory
        fs.mkdirSync(path.join(tempDir, 'src'));

        // Create worker source - tests MCP server creation and tool registration
        const workerSource = `
import { McpServer } from '@modelcontextprotocol/server';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Health check endpoint
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({ status: 'ok', runtime: 'cloudflare-workers' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Test MCP server creation and tool registration
        if (url.pathname === '/test') {
            try {
                const server = new McpServer({ name: 'cf-worker-test', version: '1.0.0' });

                // Register a tool to verify the full registration flow works
                server.registerTool('greet', {
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
                    serverName: 'cf-worker-test',
                    toolRegistered: true,
                    runtime: 'cloudflare-workers'
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
};
`;
        fs.writeFileSync(path.join(tempDir, 'src', 'index.js'), workerSource.trim());

        // Install dependencies using npm
        try {
            execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60000 });
        } catch (error) {
            console.error('npm install failed:', error);
            throw error;
        }

        // Start wrangler dev server
        wranglerProcess = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(WORKER_PORT)], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe',
        });

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Wrangler startup timeout')), 30000);

            let stdoutData = '';
            let stderrData = '';

            wranglerProcess!.stdout?.on('data', (data) => {
                stdoutData += data.toString();
                if (stdoutData.includes('Ready on') || stdoutData.includes('Listening on')) {
                    clearTimeout(timeout);
                    setTimeout(resolve, 1000);
                }
            });

            wranglerProcess!.stderr?.on('data', (data) => {
                stderrData += data.toString();
                // Check for fatal errors that indicate the worker won't start
                if (stderrData.includes('No such module "node:')) {
                    clearTimeout(timeout);
                    reject(new Error(`Worker failed to start - missing Node.js module: ${stderrData}`));
                }
            });

            wranglerProcess!.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            wranglerProcess!.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Wrangler exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });
    }, TEST_TIMEOUT);

    afterAll(async () => {
        if (wranglerProcess) {
            wranglerProcess.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                wranglerProcess!.on('close', () => resolve());
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

    it('should create MCP server and register tools in Cloudflare Workers', async () => {
        // Check health endpoint
        const healthResponse = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
        expect(healthResponse.ok).toBe(true);
        const health = await healthResponse.json() as { status: string; runtime: string };
        expect(health.status).toBe('ok');
        expect(health.runtime).toBe('cloudflare-workers');

        // Test MCP server creation and tool registration
        const testResponse = await fetch(`http://127.0.0.1:${WORKER_PORT}/test`);
        expect(testResponse.ok).toBe(true);

        const result = await testResponse.json() as {
            success: boolean;
            serverName: string;
            toolRegistered: boolean;
            runtime: string;
        };

        expect(result.success).toBe(true);
        expect(result.serverName).toBe('cf-worker-test');
        expect(result.toolRegistered).toBe(true);
        expect(result.runtime).toBe('cloudflare-workers');
    });
});
