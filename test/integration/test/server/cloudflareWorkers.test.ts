/**
 * Cloudflare Workers integration test
 *
 * Verifies the MCP server package works in Cloudflare Workers
 * WITHOUT nodejs_compat, using runtime shims for cross-platform compatibility.
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PORT = 8787;

interface TestEnv {
    tempDir: string;
    process: ChildProcess;
    cleanup: () => Promise<void>;
}

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let env: TestEnv | null = null;

    beforeAll(async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-test-'));

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
        const proc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT)], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe'
        });

        // Wait for server to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Wrangler startup timeout')), 60_000);
            let stderrData = '';

            proc.stdout?.on('data', data => {
                const output = data.toString();
                if (/Ready on|Listening on/.test(output)) {
                    clearTimeout(timeout);
                    // Extra delay for wrangler to fully initialize
                    setTimeout(resolve, 1000);
                }
            });

            proc.stderr?.on('data', data => {
                stderrData += data.toString();
                // Check for fatal errors like missing node: modules
                if (/No such module "node:/.test(stderrData)) {
                    clearTimeout(timeout);
                    reject(new Error(`Wrangler fatal error: ${stderrData}`));
                }
            });

            proc.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            proc.on('close', code => {
                if (code !== 0 && code !== null) {
                    clearTimeout(timeout);
                    reject(new Error(`Wrangler exited with code ${code}. stderr: ${stderrData}`));
                }
            });
        });

        const cleanup = async () => {
            proc.kill('SIGTERM');
            await new Promise<void>(resolve => {
                proc.on('close', () => resolve());
                setTimeout(resolve, 5000);
            });
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        };

        env = { tempDir, process: proc, cleanup };
    }, 120_000);

    afterAll(async () => {
        await env?.cleanup();
    });

    it('should handle MCP requests', async () => {
        expect(env).not.toBeNull();

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/`));

        await client.connect(transport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);

        await client.close();
    });
});
