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

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';

import type { ClientOptions } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { createMcpHandler, isInitializeRequest, isLegacyRequest } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export { strict as check } from 'node:assert';

/**
 * Serve the given factory over EITHER transport, selected from `process.argv`.
 *
 * - default: `serveStdio(factory)` — the deployable shape; the client spawns
 *   this binary and speaks JSON-RPC over the pipe.
 * - `--http [--port N]`: the documented {@linkcode isLegacyRequest} composition
 *   on `node:http` at `/` — modern (2026-07-28) traffic via a strict
 *   `createMcpHandler(factory, { legacy: 'reject' })`, 2025-era traffic via a
 *   sessionful `NodeStreamableHTTPServerTransport` (one transport+instance per
 *   session, the way you would actually deploy a 2025 server). The same
 *   factory backs both arms.
 *
 * Logs go to **stderr** so stdio's stdout JSON-RPC stream stays clean.
 */
export function runServerFromArgs(factory: McpServerFactory, defaultPort = 3000): void {
    const argv = process.argv.slice(2);
    if (argv.includes('--http')) {
        const portIdx = argv.indexOf('--port');
        const port = portIdx === -1 ? Number(process.env.PORT ?? defaultPort) : Number(argv[portIdx + 1]);

        // --- modern (2026-07-28): per-request, strict so the sessionful arm owns ALL legacy traffic ---
        const modern = createMcpHandler(factory, {
            legacy: 'reject',
            onerror: e => console.error('[server] handler error:', e.message)
        });

        // --- legacy (2025): sessionful streamable HTTP — the deployable shape ---
        const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
        const handleLegacy = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
            const sid = req.headers['mcp-session-id'] as string | undefined;
            if (sid && sessions.has(sid)) {
                await sessions.get(sid)!.handleRequest(req, res, body);
            } else if (!sid && isInitializeRequest(body)) {
                const transport = new NodeStreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: id => {
                        sessions.set(id, transport);
                    }
                });
                transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
                const instance = await factory({ era: 'legacy' });
                await instance.connect(transport);
                await transport.handleRequest(req, res, body);
            } else if (sid) {
                res.writeHead(404, { 'content-type': 'application/json' }).end(
                    JSON.stringify({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null })
                );
            } else {
                res.writeHead(400, { 'content-type': 'application/json' }).end(
                    JSON.stringify({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: Session ID required' }, id: null })
                );
            }
        };

        const server = createServer((req, res) => {
            void (async () => {
                // Read the body once for the predicate and pass it forward.
                let body: unknown;
                if (req.method === 'POST') {
                    // Collect Buffers and decode once so multi-byte UTF-8 sequences split across chunk
                    // boundaries (>~16 KiB bodies) aren't mojibaked into U+FFFD by per-chunk String().
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) chunks.push(chunk as Buffer);
                    const raw = Buffer.concat(chunks).toString('utf8');
                    try {
                        body = raw ? JSON.parse(raw) : undefined;
                    } catch {
                        body = undefined;
                    }
                }
                const probe = new globalThis.Request(`http://localhost${req.url ?? '/'}`, {
                    method: req.method,
                    headers: req.headers as Record<string, string>
                });
                await ((await isLegacyRequest(probe, body)) ? handleLegacy(req, res, body) : modern.node(req, res, body));
            })().catch(error => {
                console.error('[server] request error:', error instanceof Error ? error.message : error);
                if (!res.headersSent) res.writeHead(500).end();
            });
        });
        server.listen(port, () => console.error(`[server] listening on http://127.0.0.1:${port}/ (HTTP)`));
        const exit = async () => {
            await modern.close();
            for (const t of sessions.values()) await t.close().catch(() => {});
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
        { versionNegotiation: negotiationFromArgs(), ...options }
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
 * The `versionNegotiation` ClientOption derived from `process.argv` — the same
 * value {@linkcode connectFromArgs} applies. Use it from stories that
 * construct their own {@link Client} so the harness's `--legacy` flag still
 * selects the era.
 */
export function negotiationFromArgs(): NonNullable<ClientOptions['versionNegotiation']> {
    return { mode: process.argv.includes('--legacy') ? 'legacy' : 'auto' };
}

/**
 * The `--http <url>` argument from `process.argv`, or `defaultUrl` when the
 * flag (or its value) is absent. HTTP-only stories that construct their own
 * transport call this instead of {@linkcode connectFromArgs}. (A bare
 * `argv[argv.indexOf('--http') + 1]` reads `argv[0]` — the script path — when
 * the flag is missing, so the `?? default` never applies.)
 */
export function httpUrlFromArgs(defaultUrl: string): string {
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--http');
    if (i === -1) return defaultUrl;
    return argv[i + 1] ?? defaultUrl;
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
