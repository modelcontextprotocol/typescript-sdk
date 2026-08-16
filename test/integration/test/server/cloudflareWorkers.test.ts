/**
 * Cloudflare Workers integration test
 *
 * Verifies the MCP server package works in Cloudflare Workers
 * WITHOUT nodejs_compat, using runtime shims for cross-platform compatibility.
 */

import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_INTERVAL_MS = 100;
const SHUTDOWN_GRACE_MS = 5000;

/**
 * Embedded in the worker's `serverInfo.version` and asserted by the readiness probe, so a
 * leftover server from an earlier run can never satisfy the probe for this run.
 */
const SERVER_VERSION_NONCE = randomUUID();

/**
 * The workspace's own wrangler installation (pinned by pnpm-lock). Running it directly —
 * instead of `npm install`-ing wrangler into the temp project and going through `npx` —
 * keeps the wrangler version deterministic, avoids a ~90MB download per test run, and
 * removes two shell layers from the spawned process tree. Resolved through the package's
 * `bin` field rather than a hardcoded internal file path.
 */
const WRANGLER_BIN = (() => {
    const pkgPath = createRequire(import.meta.url).resolve('wrangler/package.json');
    const bin = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> }).bin.wrangler;
    return path.resolve(path.dirname(pkgPath), bin);
})();

/**
 * Create an installable tarball of a workspace package without mutating the workspace.
 *
 * Running `pnpm pack` inside the package is not an option here: its `prepack` hook rebuilds
 * the package in place (tsdown with `clean: true`), deleting and rewriting `packages/server/dist`
 * while the rest of the test run is still going. Anything that node-resolves the workspace
 * packages at that moment — most notably suites that spawn child processes importing
 * `@modelcontextprotocol/server` — sees a half-written dist and fails. Instead, the bundle is
 * built into a staging directory under the test's temp dir and the tarball is created from that
 * staging copy, so shared, node-resolvable state never changes while tests are running.
 *
 * Returns the tarball's file name; the tarball itself is written into `tempDir`.
 */
function packWorkspacePackage(tempDir: string, packageDirName: string): string {
    const pkgPath = path.resolve(__dirname, `../../../../packages/${packageDirName}`);
    const stagingDir = path.join(tempDir, `package-staging-${packageDirName}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    // Build the publishable bundle with its output redirected away from the workspace's
    // own dist/ (the CLI flag overrides `outDir` from tsdown.config.ts).
    execSync(`pnpm exec tsdown --out-dir "${path.join(stagingDir, 'dist')}"`, {
        cwd: pkgPath,
        stdio: 'pipe',
        timeout: 60_000
    });

    // Write a publish-shaped manifest into the staging dir: drop lifecycle scripts and
    // devDependencies, and resolve pnpm-only `catalog:`/`workspace:` specifiers to the versions
    // installed in the workspace — the same substitution `pnpm pack` performs when publishing.
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf8')) as {
        scripts?: unknown;
        devDependencies?: unknown;
        dependencies?: Record<string, string>;
    };
    delete manifest.scripts;
    delete manifest.devDependencies;
    const dependencies = manifest.dependencies ?? {};
    for (const [name, spec] of Object.entries(dependencies)) {
        if (spec.startsWith('catalog:') || spec.startsWith('workspace:')) {
            const installed = JSON.parse(fs.readFileSync(path.join(pkgPath, 'node_modules', name, 'package.json'), 'utf8')) as {
                version: string;
            };
            dependencies[name] = installed.version;
        }
    }
    fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify(manifest, null, 2));

    // Pack the staging copy. The staged manifest carries no scripts, so this is a pure tar step;
    // npm is used because the staging dir lives outside the pnpm workspace.
    const packOutput = execSync(`npm pack --pack-destination "${tempDir}"`, {
        cwd: stagingDir,
        encoding: 'utf8',
        timeout: 60_000
    });
    return path.basename(packOutput.trim().split('\n').pop()!);
}

/** Ask the kernel for a currently-free port instead of hardcoding one. */
async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

/**
 * Kill the whole `wrangler dev` process tree.
 *
 * `wrangler dev` fans out into several processes (wrangler bin shim → wrangler CLI →
 * esbuild service + two workerd instances), and non-interactive wrangler installs no
 * SIGTERM handler that would dispose them. Signalling just `proc.pid` kills the top of
 * the tree and orphans workerd, which keeps running — and keeps its port bound —
 * indefinitely. So the process is spawned `detached` (own process group) and the whole
 * group is signalled here, with a SIGKILL sweep afterwards because a wedged workerd can
 * ignore SIGTERM. Orphaned workerd is a known recurring wrangler bug class (e.g.
 * cloudflare/workers-sdk#9193); Cloudflare's own CI harness likewise tree-kills rather
 * than trusting signal propagation.
 *
 * Caveat: if the test runner itself dies abruptly (`kill -9`, OOM), nothing here runs and
 * the detached tree is orphaned; a process 'exit' guard in beforeAll covers ordinary
 * fatal exits, and an orphan can't affect later runs (ephemeral port + readiness nonce).
 */
async function killWranglerTree(proc: ChildProcess): Promise<void> {
    if (proc.pid === undefined) {
        return;
    }
    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch {
            // Tree already gone
        }
        return;
    }
    try {
        process.kill(-proc.pid, 'SIGTERM');
    } catch {
        // Group already gone
    }
    // Wait on 'exit', not 'close': surviving grandchildren inherit the stdio pipes, so
    // 'close' can stay pending long after wrangler itself died.
    if (proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
            proc.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    try {
        process.kill(-proc.pid, 'SIGKILL');
    } catch {
        // Group already gone — the expected case after a clean SIGTERM shutdown
    }
}

/**
 * Wait until the worker can serve a real MCP `initialize` request.
 *
 * Wrangler's "Ready on …" stdout line is unreliable: miniflare can print it before the user
 * worker is actually wired, and subsequent POSTs come back as `500 Network connection lost` or
 * `ECONNREFUSED`. The only signal we can trust is "the server returned an MCP-shaped response
 * to a protocol request" — and specifically a response carrying this run's
 * {@link SERVER_VERSION_NONCE}, so a stale server from a previous run can't pass the probe.
 *
 * Polls the given port with an MCP `initialize` POST every {@link READINESS_POLL_INTERVAL_MS}ms
 * until either a matching JSON-RPC result body comes back, the wrangler process exits, or
 * {@link READINESS_TIMEOUT_MS} elapses. Each probe is individually bounded so a wedged server
 * that accepts connections but never responds can't stall the loop.
 */
async function waitForMcpReady(proc: ChildProcess, port: number): Promise<void> {
    let stderrTail = '';
    proc.stderr?.on('data', d => {
        stderrTail = (stderrTail + d.toString()).slice(-2048);
    });
    // Keep stdout flowing too: nothing reads it otherwise, and a full pipe buffer would make
    // wrangler queue log writes in memory for as long as the server runs.
    let stdoutTail = '';
    proc.stdout?.on('data', d => {
        stdoutTail = (stdoutTail + d.toString()).slice(-2048);
    });

    let processFailure: string | null = null;
    proc.on('exit', (code, signal) => {
        processFailure = signal === null ? `exited with code ${code ?? -1}` : `was killed by ${signal}`;
    });
    proc.on('error', error => {
        processFailure = `failed to spawn: ${error.message}`;
    });

    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    let lastFailure = 'no attempts made';

    while (Date.now() < deadline) {
        if (processFailure !== null) {
            throw new Error(
                `wrangler dev ${processFailure} before becoming ready.\nstdout tail:\n${stdoutTail}\nstderr tail:\n${stderrTail}`
            );
        }

        try {
            const response = await fetch(`http://127.0.0.1:${port}/`, {
                method: 'POST',
                signal: AbortSignal.timeout(2000),
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
            if (response.ok && body.includes('"jsonrpc"') && body.includes('"result"') && body.includes(SERVER_VERSION_NONCE)) {
                return;
            }
            lastFailure = `status=${response.status} body=${body.slice(0, 200)}`;
        } catch (error) {
            lastFailure = (error as { cause?: { code?: string }; message: string }).cause?.code ?? (error as Error).message;
        }

        await new Promise(resolve => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
    }

    throw new Error(
        `Worker did not become ready within ${READINESS_TIMEOUT_MS}ms.\nLast probe: ${lastFailure}\nstdout tail:\n${stdoutTail}\nstderr tail:\n${stderrTail}`
    );
}

describe('Cloudflare Workers compatibility (no nodejs_compat)', () => {
    let port = 0;
    let cleanup: (() => Promise<void>) | null = null;

    beforeAll(async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-worker-test-'));
        let proc: ChildProcess | null = null;
        let orphanGuard: (() => void) | null = null;

        // Registered before anything can fail (including a vitest hook timeout, which skips
        // the catch below but still runs afterAll): kill the process tree, then the temp dir.
        cleanup = async () => {
            if (orphanGuard) {
                process.removeListener('exit', orphanGuard);
                orphanGuard = null;
            }
            if (proc) {
                await killWranglerTree(proc);
            }
            try {
                fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
            } catch {
                // Ignore cleanup errors
            }
        };

        try {
            // Pack the server package into the temp dir without touching the workspace's own
            // dist/ — see packWorkspacePackage for why the plain `pnpm pack` route is unsafe here.
            // Also pack @modelcontextprotocol/core from the workspace: the packed server resolves
            // `@modelcontextprotocol/core/internal` at runtime, and the registry copy of core may
            // not carry that subpath yet — the test must exercise the workspace pair together.
            const tarballName = packWorkspacePackage(tempDir, 'server');
            const coreTarballName = packWorkspacePackage(tempDir, 'core');

            // Write package.json
            const pkgJson = {
                name: 'cf-worker-test',
                private: true,
                type: 'module',
                dependencies: {
                    '@modelcontextprotocol/core': `file:./${coreTarballName}`,
                    '@modelcontextprotocol/server': `file:./${tarballName}`
                }
            };
            fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

            // Write wrangler config
            const wranglerConfig = {
                name: 'cf-worker-test',
                main: 'server.ts',
                compatibility_date: '2025-01-01'
            };
            fs.writeFileSync(path.join(tempDir, 'wrangler.jsonc'), JSON.stringify(wranglerConfig, null, 2));

            // Write server source
            const serverSource = `
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';

const server = new McpServer({ name: "test-server", version: "${SERVER_VERSION_NONCE}" });

server.registerTool("greet", {
    description: "Greet someone",
    inputSchema: z.object({ name: z.string() })
}, async ({ name }) => ({
    content: [{ type: "text", text: "Hello, " + name + "!" }]
}));

const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);

export default {
    fetch: (request) => transport.handleRequest(request)
};
`;
            fs.writeFileSync(path.join(tempDir, 'server.ts'), serverSource);

            // Install dependencies (just the packed server tarball — wrangler comes from the
            // workspace, see WRANGLER_BIN)
            execSync('npm install --no-audit --no-fund --prefer-offline', { cwd: tempDir, stdio: 'pipe', timeout: 60_000 });

            // Start wrangler dev directly from the workspace installation, in its own process
            // group so the whole tree can be torn down — see killWranglerTree. Readiness is
            // determined by probing the MCP endpoint, not by parsing wrangler's stdout — see
            // waitForMcpReady for the reasoning.
            port = await getFreePort();
            proc = spawn(process.execPath, [WRANGLER_BIN, 'dev', '--local', '--port', String(port)], {
                cwd: tempDir,
                stdio: 'pipe',
                detached: process.platform !== 'win32'
            });

            // Best-effort orphan guard: if the runner dies without running afterAll
            // (process.exit, fatal error), take the detached tree down with it. Signal
            // deaths (SIGKILL, OOM) can't be intercepted — see killWranglerTree.
            if (process.platform !== 'win32' && proc.pid !== undefined) {
                const pgid = proc.pid;
                orphanGuard = () => {
                    try {
                        process.kill(-pgid, 'SIGKILL');
                    } catch {
                        // Tree already gone
                    }
                };
                process.once('exit', orphanGuard);
            }

            await waitForMcpReady(proc, port);
        } catch (error) {
            await cleanup();
            throw error;
        }
    }, 180_000);

    afterAll(async () => {
        await cleanup?.();
    }, 30_000);

    it('should handle MCP requests', async () => {
        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`));
        await client.connect(transport);

        const result = await client.callTool({ name: 'greet', arguments: { name: 'Workers' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Hello, Workers!' }]);

        await client.close();
    }, 30_000);
});
