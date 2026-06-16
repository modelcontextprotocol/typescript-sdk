/**
 * Smoke coverage for the dual-era example programs, executed as real child
 * processes (the way a reader of the docs would run them):
 *
 * - `examples/client/src/dualEraStdioClient.ts` is run via tsx and must drive
 *   both legs against the stdio server example it spawns itself: leg 1
 *   negotiates 2025-11-25 over `initialize`, leg 2 negotiates 2026-07-28 over
 *   `server/discover`, both greet calls succeed, and the program exits 0.
 * - `examples/server/src/dualEraStreamableHttp.ts` is run via tsx once per
 *   `MCP_LEGACY_MODE` value (none / stateless / byo) and probed over real
 *   HTTP: a 2025-shaped `initialize` (served on the legacy slot, rejected on
 *   the strict endpoint), `server/discover`, and a `tools/call` carrying the
 *   2026 per-request `_meta` envelope.
 *
 * The HTTP example listens on a hard-coded port (3000) with no override knob,
 * so these tests serialize on that port: stale listeners are cleared before
 * each spawn (listeners only — `lsof -sTCP:LISTEN`, never a bare kill by
 * port), and the spawned child is always stopped by PID.
 *
 * The examples resolve the workspace packages through their published dist
 * entry points, so the suite requires `pnpm build:all` to have run. During a
 * full integration run, cloudflareWorkers.test.ts repacks the server package
 * (`pnpm pack` → prepack → build), which transiently rewrites
 * packages/server/dist; an example spawned inside that window dies with a
 * missing-dist module error. Such failures are retried a bounded number of
 * times so only genuine example breakage fails the suite.
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const STDIO_CLIENT_EXAMPLE = path.join(REPO_ROOT, 'examples/client/src/dualEraStdioClient.ts');
const HTTP_SERVER_EXAMPLE = path.join(REPO_ROOT, 'examples/server/src/dualEraStreamableHttp.ts');

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';

/** The HTTP example's hard-coded listen port (it exposes no override). */
const EXAMPLE_PORT = 3000;
const EXAMPLE_URL = `http://localhost:${EXAMPLE_PORT}/mcp`;

/** Failure signature of a workspace dist being rewritten underneath a spawned example (see the file header). */
const MISSING_DIST_PATTERN = /(ERR_MODULE_NOT_FOUND|ENOENT)[\s\S]*[/\\]dist[/\\]/;
const MAX_ATTEMPTS = 3;

interface RunningExample {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    stdout: () => string;
    stderr: () => string;
}

describe('dual-era examples run as real programs', () => {
    vi.setConfig({ testTimeout: 120_000 });

    const activeChildren: ChildProcess[] = [];

    afterEach(() => {
        // Belt and braces: never let a spawned example outlive its test.
        for (const child of activeChildren.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
        }
    });

    function spawnExample(scriptPath: string, env: Record<string, string> = {}): RunningExample {
        const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        activeChildren.push(child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => {
            stdout += String(chunk);
        });
        child.stderr?.on('data', chunk => {
            stderr += String(chunk);
        });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
            child.on('exit', (code, signal) => resolve({ code, signal }));
        });
        return { child, exited, stdout: () => stdout, stderr: () => stderr };
    }

    it('dualEraStdioClient drives both legs against the stdio server example and exits cleanly', async () => {
        let example = spawnExample(STDIO_CLIENT_EXAMPLE);
        let { code, signal } = await example.exited;
        for (let attempt = 1; attempt < MAX_ATTEMPTS && code !== 0 && MISSING_DIST_PATTERN.test(example.stderr()); attempt++) {
            // A workspace dist was being rewritten underneath the example; wait it out and rerun.
            await delay(10_000);
            example = spawnExample(STDIO_CLIENT_EXAMPLE);
            ({ code, signal } = await example.exited);
        }
        const stdout = example.stdout();

        expect(code, `expected exit 0\nstdout:\n${stdout}\nstderr:\n${example.stderr()}`).toBe(0);
        expect(signal).toBeNull();

        // Split the transcript at the leg-2 marker so each negotiation and
        // greeting is asserted against its own leg.
        const legBoundary = stdout.indexOf('--- leg 2');
        expect(legBoundary, `expected the leg-2 marker in stdout:\n${stdout}`).toBeGreaterThan(-1);
        const leg1 = stdout.slice(0, legBoundary);
        const leg2 = stdout.slice(legBoundary);

        expect(leg1).toContain('--- leg 1');
        expect(leg1).toContain(`negotiated protocol version: ${LEGACY}`);
        expect(leg1).toContain('Hello, 2025 client!');

        expect(leg2).toContain(`negotiated protocol version: ${MODERN}`);
        expect(leg2).toContain('Hello, 2026 client!');

        expect(stdout).toContain('both legs served by the same dual-era stdio server.');
    });

    // ── HTTP example (one spawn per MCP_LEGACY_MODE value) ──────────────────

    /** Kills stale listeners on the example's hard-coded port (LISTEN sockets only — never a bare kill by port). */
    async function clearStalePortListeners(): Promise<void> {
        await new Promise<void>(resolve => {
            const cleanup = spawn('sh', ['-c', `lsof -ti:${EXAMPLE_PORT} -sTCP:LISTEN | xargs -r kill`], { stdio: 'ignore' });
            cleanup.on('exit', () => resolve());
            cleanup.on('error', () => resolve());
        });
    }

    async function startHttpExample(mode: 'none' | 'stateless' | 'byo'): Promise<RunningExample> {
        for (let attempt = 1; ; attempt++) {
            await clearStalePortListeners();
            const example = spawnExample(HTTP_SERVER_EXAMPLE, { MCP_LEGACY_MODE: mode });
            // Wait for the listening line, but stop waiting as soon as the child exits.
            let exited = false;
            void example.exited.then(() => {
                exited = true;
            });
            await vi.waitFor(
                () => {
                    if (!example.stdout().includes('Dual-era MCP server listening') && !exited) throw new Error('not listening yet');
                },
                { timeout: 60_000, interval: 100 }
            );
            if (example.stdout().includes('Dual-era MCP server listening')) {
                expect(example.stdout()).toContain(`legacy mode: ${mode}`);
                return example;
            }
            if (attempt < MAX_ATTEMPTS && MISSING_DIST_PATTERN.test(example.stderr())) {
                // A workspace dist was being rewritten underneath the example; wait it out and respawn.
                await delay(10_000);
                continue;
            }
            throw new Error(`example exited before listening\nstdout:\n${example.stdout()}\nstderr:\n${example.stderr()}`);
        }
    }

    /** Stops the spawned example by PID and asserts it shuts down cleanly (the example handles SIGINT itself). */
    async function stopHttpExample(example: RunningExample): Promise<void> {
        if (example.child.exitCode === null && example.child.signalCode === null) {
            example.child.kill('SIGINT');
        }
        const { code, signal } = await example.exited;
        expect(signal).toBeNull();
        expect(code).toBe(0);
    }

    function modernEnvelope() {
        return {
            [PROTOCOL_VERSION_META_KEY]: MODERN,
            [CLIENT_INFO_META_KEY]: { name: 'examples-smoke-client', version: '1.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {}
        };
    }

    const legacyInitialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'legacy-probe', version: '1.0.0' } }
    };

    /** POSTs one JSON-RPC message and returns the HTTP status plus the parsed JSON-RPC response (JSON or SSE body). */
    async function postJsonRpc(
        message: Record<string, unknown>
    ): Promise<{ status: number; message: Record<string, unknown> | undefined }> {
        const response = await fetch(EXAMPLE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify(message)
        });
        const text = await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        let parsed: Record<string, unknown> | undefined;
        if (contentType.includes('text/event-stream')) {
            parsed = text
                .split('\n')
                .filter(line => line.startsWith('data: '))
                .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
                .find(candidate => 'result' in candidate || 'error' in candidate);
        } else if (text !== '') {
            parsed = JSON.parse(text) as Record<string, unknown>;
        }
        return { status: response.status, message: parsed };
    }

    /** The 2026-07-28 path is identical in every slot state: discover advertises it and an enveloped tools/call is served. */
    async function probeModernPath(): Promise<void> {
        const discover = await postJsonRpc({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: modernEnvelope() } });
        expect(discover.status).toBe(200);
        const discoverResult = (discover.message as { result?: { supportedVersions?: string[]; serverInfo?: { name?: string } } }).result;
        expect(discoverResult?.supportedVersions).toContain(MODERN);
        expect(discoverResult?.serverInfo?.name).toBe('dual-era-server');

        const call = await postJsonRpc({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'greet', arguments: { name: 'smoke probe' }, _meta: modernEnvelope() }
        });
        expect(call.status).toBe(200);
        const callResult = (call.message as { result?: { resultType?: string; content?: unknown } }).result;
        expect(callResult?.resultType).toBe('complete');
        expect(callResult?.content).toEqual([{ type: 'text', text: 'Hello, smoke probe! (served on the modern protocol era)' }]);
    }

    it.each(['stateless', 'byo'] as const)('dualEraStreamableHttp with MCP_LEGACY_MODE=%s serves both eras over real HTTP', async mode => {
        const example = await startHttpExample(mode);
        try {
            const init = await postJsonRpc(legacyInitialize);
            expect(init.status).toBe(200);
            const initResult = (init.message as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } }).result;
            expect(initResult?.protocolVersion).toBe(LEGACY);
            expect(initResult?.serverInfo?.name).toBe('dual-era-server');

            await probeModernPath();
        } finally {
            await stopHttpExample(example);
        }
    });

    it('dualEraStreamableHttp with MCP_LEGACY_MODE=none rejects 2025-shaped initialize and still serves the modern path', async () => {
        const example = await startHttpExample('none');
        try {
            const init = await postJsonRpc(legacyInitialize);
            expect(init.status).toBe(400);
            const error = (init.message as { error?: { message?: string; data?: { supported?: string[] } } }).error;
            expect(error?.message).toMatch(/unsupported protocol version/i);
            expect(error?.data?.supported).toContain(MODERN);

            await probeModernPath();
        } finally {
            await stopHttpExample(example);
        }
    });
});
