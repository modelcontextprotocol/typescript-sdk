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
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_INTERVAL_MS = 100;

/**
 * Wait until the worker can serve a real MCP `initialize` request.
 *
 * Wrangler's "Ready on …" stdout line is unreliable: miniflare can print it before the user
 * worker is actually wired, and subsequent POSTs come back as `500 Network connection lost` or
 * `ECONNREFUSED`. The only signal we can trust is "the server returned an MCP-shaped response
 * to a protocol request".
 *
 * Polls the configured port with an MCP `initialize` POST every {@link READINESS_POLL_INTERVAL_MS}ms
 * until either a JSON-RPC result body comes back, the wrangler process exits, or
 * {@link READINESS_TIMEOUT_MS} elapses.
 */
async function waitForMcpReady(proc: ChildProcess): Promise<void> {
    let stderrTail = '';
    proc.stderr?.on('data', d => {
        stderrTail = (stderrTail + d.toString()).slice(-2048);
    });

    let processExitedWithCode: number | null = null;
    proc.on('exit', code => {
        processExitedWithCode = code ?? -1;
    });

    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    let lastFailure = 'no attempts made';

    while (Date.now() < deadline) {
        if (processExitedWithCode !== null) {
            throw new Error(`wrangler dev exited with code ${processExitedWithCode} before becoming ready.\nstderr tail:\n${stderrTail}`);
        }

        try {
            const response = await fetch(`http://127.0.0.1:${PORT}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'readiness-probe',
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-06-18',
                        capabilities: {},
                        clientInfo: { name: 'readiness-probe', version: '0' }
                    }
                })
            });
            const body = await response.text();
            if (response.ok && body.includes('"jsonrpc"') && body.includes('"result"')) {
                return;
            }
            lastFailure = `status=${response.status} body=${body.slice(0, 200)}`;
        } catch (error) {
            lastFailure = (error as { cause?: { code?: string }; message: string }).cause?.code ?? (error as Error).message;
        }

        await new Promise(resolve => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
    }

    throw new Error(
        `Worker did not become ready within ${READINESS_TIMEOUT_MS}ms.\nLast probe: ${lastFailure}\nstderr tail:\n${stderrTail}`
    );
}

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let cleanup: (() => Promise<void>) | null = null;

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
                '@modelcontextprotocol/server': `file:./${tarballName}`
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

        // Start wrangler dev server. Readiness is determined by probing the MCP endpoint, not by
        // parsing wrangler's stdout — see waitForMcpReady for the reasoning.
        const proc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT)], {
            cwd: tempDir,
            shell: true,
            stdio: 'pipe'
        });

        try {
            await waitForMcpReady(proc);
        } catch (error) {
            proc.kill('SIGTERM');
            throw error;
        }

        cleanup = async () => {
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
    }, 120_000);

    afterAll(async () => {
        await cleanup?.();
    });

    it('should handle MCP requests', async () => {
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/`));
        await client.connect(transport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'World' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, World!' }]);

        await client.close();
    }, 30_000);
});
