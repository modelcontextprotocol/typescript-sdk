/**
 * Tiny dual-transport scaffold shared by every `examples/<story>/` pair.
 *
 * The same factory backs both transports of one example: a story's `server.ts`
 * calls {@linkcode runServerFromArgs} so one binary serves stdio (default) or
 * HTTP under `--http --port <N>`; its `client.ts` calls
 * {@linkcode connectFromArgs} so one binary spawns the sibling server over
 * stdio (default) or connects to a running endpoint under `--http <url>`, and
 * negotiates the modern (2026-07-28) era by default or the 2025 `initialize`
 * handshake under `--legacy`. The client's body is wrapped in
 * {@linkcode runClient} so any thrown assertion exits non-zero with a `FAIL:`
 * line, making each example a self-verifying e2e test that
 * `scripts/run-examples.ts` can iterate over the transport × era matrix.
 *
 * Re-exported `check` is `node:assert/strict` for readable inline assertions.
 */

import { createServer } from 'node:http';
import path from 'node:path';

import type { ClientOptions } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export { strict as check } from 'node:assert';

/**
 * Serve the given factory over EITHER transport, selected from `process.argv`.
 *
 * - default: `serveStdio(factory)` — the deployable shape; the client spawns
 *   this binary and speaks JSON-RPC over the pipe.
 * - `--http [--port N]`: `createMcpHandler(factory)` mounted on `node:http`
 *   at `/` (so the harness's readiness poll and the client's URL agree).
 *
 * Logs go to **stderr** so stdio's stdout JSON-RPC stream stays clean.
 */
export function runServerFromArgs(factory: McpServerFactory, defaultPort = 3000): void {
    const argv = process.argv.slice(2);
    if (argv.includes('--http')) {
        const portIdx = argv.indexOf('--port');
        const port = portIdx === -1 ? Number(process.env.PORT ?? defaultPort) : Number(argv[portIdx + 1]);
        const handler = createMcpHandler(factory, { onerror: e => console.error('[server] handler error:', e.message) });
        const server = createServer((req, res) => void handler.node(req, res));
        server.listen(port, () => console.error(`[server] listening on http://127.0.0.1:${port}/ (HTTP)`));
        const exit = async () => {
            await handler.close();
            server.close();
            process.exit(0);
        };
        process.on('SIGINT', exit);
        process.on('SIGTERM', exit);
    } else {
        const handle = serveStdio(factory);
        console.error('[server] serving over stdio');
        const exit = async () => {
            await handle.close();
            process.exit(0);
        };
        process.on('SIGINT', exit);
        process.on('SIGTERM', exit);
    }
}

/**
 * Construct a {@link Client} and connect it over EITHER transport, selected
 * from `process.argv`. Under `--http <url>` it connects to the given endpoint
 * via Streamable HTTP; otherwise it spawns the sibling `server.ts` (resolved
 * relative to the calling client's `import.meta.dirname`) via stdio.
 *
 * The protocol era is selected from `process.argv` too: under `--legacy` the
 * client uses `versionNegotiation: { mode: 'legacy' }` (the plain 2025
 * `initialize` handshake); otherwise `{ mode: 'auto' }` so the
 * `server/discover` probe negotiates the 2026-07-28 revision against either
 * transport without per-story envelope plumbing. Pass
 * `options.versionNegotiation` explicitly to opt out (for stories that drive
 * both eras within one body).
 */
export async function connectFromArgs(siblingDir: string, options: ClientOptions = {}): Promise<Client> {
    const argv = process.argv.slice(2);
    const client = new Client(
        { name: `${path.basename(siblingDir)}-example-client`, version: '1.0.0' },
        { versionNegotiation: { mode: argv.includes('--legacy') ? 'legacy' : 'auto' }, ...options }
    );
    const httpIdx = argv.indexOf('--http');
    if (httpIdx === -1) {
        const serverSource = path.resolve(siblingDir, 'server.ts');
        await client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', serverSource] }));
    } else {
        const url = argv[httpIdx + 1] ?? 'http://127.0.0.1:3000/';
        await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(url)));
    }
    return client;
}

/** Transport leg the client is running on this invocation. */
export function transportLeg(): 'stdio' | 'http' {
    return process.argv.includes('--http') ? 'http' : 'stdio';
}

/** Protocol-era leg the client is running on this invocation. */
export function eraLeg(): 'modern' | 'legacy' {
    return process.argv.includes('--legacy') ? 'legacy' : 'modern';
}

/**
 * Run a self-verifying client scenario. Any thrown error (including
 * `node:assert/strict` failures) prints a `FAIL:` line to stderr and exits
 * non-zero so the harness records the failure; on success it prints an `OK:`
 * line and exits 0.
 */
export function runClient(name: string, scenario: () => Promise<void>): void {
    void (async () => {
        const leg = `${transportLeg()}/${eraLeg()}`;
        try {
            await scenario();
            console.log(`OK: ${name} (${leg})`);
            process.exit(0);
        } catch (error) {
            const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
            console.error(`FAIL: ${name} (${leg}): ${message}`);
            process.exit(1);
        }
    })();
}
