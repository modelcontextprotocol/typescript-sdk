/**
 * Cloudflare Workers integration test
 *
 * Verifies the MCP server package works in Cloudflare Workers
 * WITHOUT nodejs_compat, using runtime shims for cross-platform compatibility.
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface TestEnv {
    tempDir: string;
    process: ChildProcess;
    port: number;
    stdout: string;
    stderr: string;
    cleanup: () => Promise<void>;
}

async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (address && typeof address === 'object') {
                    resolve(address.port);
                } else {
                    reject(new Error('Unable to allocate a port for wrangler'));
                }
            });
        });
    });
}

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let env: TestEnv | null = null;

    beforeAll(async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-test-'));
        const port = await getAvailablePort();

        // Pack server package
        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');
        const packOutput = execSync(`pnpm pack --pack-destination ${tempDir}`, {
            cwd: serverPkgPath,
            encoding: 'utf8'
        });
        const tarballName = path.basename(packOutput.trim().split('\n').pop()!);

        // Write package.json
        const pkgJson = {
            name: 'cf-worker-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1'
            },
            devDependencies: {
                wrangler: '^4.14.4'
            }
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        // Write wrangler config
        const wranglerConfig = {
            $schema: 'node_modules/wrangler/config-schema.json',
            name: 'cf-worker-test',
            main: 'server.ts',
            compatibility_date: '2025-01-01'
        };
        fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify(wranglerConfig, null, 2));

        // Write server source
        const serverSource = `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const server = new McpServer({ name: "test-server", version: "1.0.0" });

server.registerTool("greet", {
    description: "Greet someone"
}, async (args) => ({
    content: [{ type: "text", text: "Hello, " + (args.name || "World") + "!" }]
}));

const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);

export default {
    fetch: (request) => transport.handleRequest(request)
};
`;
        fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource);

        // Install dependencies
        execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

        // Start wrangler dev server
        const proc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(port)], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe'
        });

        const cleanup = async () => {
            proc.kill('SIGTERM');
            await new Promise<void>(resolve => {
                proc.once('close', () => resolve());
                setTimeout(resolve, 5000);
            });
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        };

        env = { tempDir, process: proc, port, stdout: '', stderr: '', cleanup };

        // Wait for server to be ready
        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const timeout = setTimeout(() => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    reject(new Error(`Wrangler startup timeout. stdout: ${env?.stdout}\nstderr: ${env?.stderr}`));
                }, 60_000);
                const settle = (callback: () => void) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timeout);
                    callback();
                };

                proc.stdout?.on('data', data => {
                    const output = data.toString();
                    if (env) {
                        env.stdout += output;
                    }
                    if (/Ready on|Listening on/.test(output)) {
                        settle(() => {
                            // Extra delay for wrangler to fully initialize
                            setTimeout(resolve, 1000);
                        });
                    }
                });

                proc.stderr?.on('data', data => {
                    const output = data.toString();
                    if (env) {
                        env.stderr += output;
                    }
                    // Check for fatal errors like missing node: modules
                    if (/No such module "node:/.test(env?.stderr ?? '')) {
                        settle(() => reject(new Error(`Wrangler fatal error: ${env?.stderr}`)));
                    }
                });

                proc.on('error', err => {
                    settle(() => reject(err));
                });

                proc.on('close', code => {
                    if (code !== 0 && code !== null) {
                        settle(() =>
                            reject(new Error(`Wrangler exited with code ${code}. stdout: ${env?.stdout}\nstderr: ${env?.stderr}`))
                        );
                    }
                });
            });
        } catch (error) {
            await cleanup();
            env = null;
            throw error;
        }
    }, 120_000);

    afterAll(async () => {
        await env?.cleanup();
    });

    it('should handle MCP requests', async () => {
        expect(env).not.toBeNull();

        // Retry connection — wrangler may report "Ready" before it can handle requests
        let client!: Client;
        let lastError: unknown;
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                client = new Client({ name: 'test-client', version: '1.0.0' });
                const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${env!.port}/`));
                await client.connect(transport);
                lastError = undefined;
                break;
            } catch (error) {
                lastError = error;
                await client?.close().catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        if (lastError) {
            throw new Error(`Unable to connect to wrangler MCP worker. stdout: ${env?.stdout}\nstderr: ${env?.stderr}`, {
                cause: lastError
            });
        }

        const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);

        await client.close();
    }, 30_000);
});
