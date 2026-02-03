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

const WORKER_PORT = 8787;
const TEST_TIMEOUT = 120_000;

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let wranglerProcess: ChildProcess | null = null;
    let tempDir: string;

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-test-'));

        const serverPkgPath = path.resolve(__dirname, '../../../../packages/server');
        const packOutput = execSync('pnpm pack --pack-destination ' + tempDir, {
            cwd: serverPkgPath,
            encoding: 'utf8'
        });
        const tarballName = path.basename(packOutput.trim().split('\n').pop()!);

        const pkgJson = {
            name: 'cf-worker-test',
            private: true,
            type: 'module',
            dependencies: {
                '@modelcontextprotocol/server': `file:./${tarballName}`,
                '@cfworker/json-schema': '^4.1.1'
            },
            devDependencies: {
                wrangler: '^4.0.0'
            }
        };
        fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

        const wranglerConfig = {
            $schema: 'node_modules/wrangler/config-schema.json',
            name: 'cf-worker-test',
            main: 'src/index.js',
            compatibility_date: '2026-02-03'
        };
        fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify(wranglerConfig, null, 2));

        fs.mkdirSync(path.join(tempDir, 'src'));

        const workerSource = `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'cf-worker-test', version: '1.0.0' });

server.registerTool('greet', {
    description: 'Greet someone',
    inputSchema: { name: { type: 'string' } }
}, async ({ name }) => ({
    content: [{ type: 'text', text: 'Hello, ' + name + '!' }]
}));

const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);

export default {
    fetch: (request) => transport.handleRequest(request)
};
`;
        fs.writeFileSync(path.join(tempDir, 'src', 'index.js'), workerSource.trim());

        execSync('npm install', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

        wranglerProcess = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(WORKER_PORT)], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe'
        });

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Wrangler startup timeout')), 30_000);
            let stderrData = '';

            wranglerProcess!.stdout?.on('data', data => {
                if (data.toString().includes('Ready on') || data.toString().includes('Listening on')) {
                    clearTimeout(timeout);
                    setTimeout(resolve, 1000);
                }
            });

            wranglerProcess!.stderr?.on('data', data => {
                stderrData += data.toString();
                if (stderrData.includes('No such module "node:')) {
                    clearTimeout(timeout);
                    reject(new Error(`Worker failed to start - missing Node.js module: ${stderrData}`));
                }
            });

            wranglerProcess!.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            wranglerProcess!.on('close', code => {
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
            await new Promise<void>(resolve => {
                wranglerProcess!.on('close', () => resolve());
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
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${WORKER_PORT}/`));

        await client.connect(transport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);

        await client.close();
    });
});
