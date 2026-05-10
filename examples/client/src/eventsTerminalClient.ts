/**
 * Interactive terminal MCP client for the Events primitive — subscribe,
 * unsubscribe, and watch deliveries across all three modes (poll/push/webhook).
 * No LLM involved; this is a protocol exerciser.
 *
 * SETUP
 *   1. (HTTP mode only) Start an events-capable MCP server. None of the bundled
 *      events examples serve HTTP yet, so the default below spawns the stdio
 *      example in-process instead.
 *   2. Run this client:
 *        pnpm --filter @modelcontextprotocol/examples-client exec tsx src/eventsTerminalClient.ts
 *   3. Type `help` at the prompt.
 *
 * ENV
 *   MCP_URL   If set, connect via Streamable HTTP to this URL instead of
 *             spawning the stdio example server. Example:
 *               MCP_URL=http://localhost:3000/mcp pnpm ... eventsTerminalClient.ts
 *
 * EXAMPLE SESSION
 *   events> list
 *   events> sub counter.tick poll {"minValue":0}
 *   events> sub counter.tick push
 *   events> sub counter.tick webhook
 *   events> subs
 *   events> unsub 1
 *   events> quit
 *
 * DESIGN DECISIONS
 *   1. Dual transport. The directive specified HTTP, but the only bundled events
 *      server (`eventsExample.ts`) is stdio-only. So: if `MCP_URL` is set we use
 *      `StreamableHTTPClientTransport`; otherwise we spawn `eventsExample.ts
 *      --webhook` over stdio so all three delivery modes are available.
 *   2. One shared webhook listener at `http://127.0.0.1:<random>/hook`. The SDK's
 *      `ClientEventManager` accepts a single `WebhookConfig.url` and routes by the
 *      `X-MCP-Subscription-Id` header, so per-subscription URL paths are
 *      unnecessary. The same client-supplied `whsec_` secret is used for all
 *      subscriptions originated from this manager.
 *   3. `unsub` accepts either the full subscription UUID or a 1-based index from
 *      `subs` — UUIDs are unwieldy in a REPL.
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';

import type { EventDeliveryMode, EventOccurrence, EventSubscription, WebhookControlEnvelope } from '@modelcontextprotocol/client';
import {
    Client,
    ClientEventManager,
    generateWebhookSecret,
    StdioClientTransport,
    StreamableHTTPClientTransport,
    verifyWebhookSignature,
    WEBHOOK_ID_HEADER,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_SUBSCRIPTION_ID_HEADER,
    WEBHOOK_TIMESTAMP_HEADER
} from '@modelcontextprotocol/client';

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'events> ' });

function out(line: string): void {
    process.stdout.write(`\r${line}\n`);
    rl.prompt(true);
}

function printOccurrence(mode: string, ev: EventOccurrence): void {
    out(`  [${mode}] ${ev.name} ${ev.eventId} cursor=${ev.cursor} ${ev.timestamp}: ${JSON.stringify(ev.data)}`);
}

function help(): void {
    out(
        [
            'commands:',
            '  list                                 list available event types',
            '  sub <name> <poll|push|webhook> [json] [--from <cursor>] [--max-age-ms <ms>]   subscribe',
            '  unsub [index|id]                     cancel one (or all if no arg)',
            '  subs                                 list active subscriptions',
            '  help                                 this help',
            '  quit                                 unsubscribe all and exit'
        ].join('\n')
    );
}

// ---- webhook listener ----------------------------------------------------

const webhookSecret = generateWebhookSecret();
let webhookServer: Server | undefined;
let webhookUrl: string | undefined;
let activeManager: ClientEventManager | undefined;

async function ensureWebhookListener(): Promise<string> {
    if (webhookUrl) return webhookUrl;
    webhookServer = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/hook') {
            res.writeHead(405).end();
            return;
        }
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            void (async () => {
                const subId = req.headers[WEBHOOK_SUBSCRIPTION_ID_HEADER.toLowerCase()] as string | undefined;
                if (!subId) {
                    res.writeHead(400).end();
                    return;
                }
                const verify = await verifyWebhookSignature(
                    webhookSecret,
                    body,
                    req.headers[WEBHOOK_ID_HEADER] as string,
                    req.headers[WEBHOOK_TIMESTAMP_HEADER] as string,
                    req.headers[WEBHOOK_SIGNATURE_HEADER] as string
                );
                if (!verify.valid) {
                    out(`  [webhook] rejected delivery for ${subId}: ${verify.reason}`);
                    res.writeHead(401).end();
                    return;
                }
                let payload: EventOccurrence | WebhookControlEnvelope;
                try {
                    payload = JSON.parse(body);
                } catch {
                    res.writeHead(400).end();
                    return;
                }
                activeManager?.deliverWebhookPayload(subId, payload);
                if ('type' in payload) {
                    out(`  [webhook] control ${payload.type} for ${subId}`);
                }
                res.writeHead(200).end();
            })();
        });
    });
    await new Promise<void>(resolve => webhookServer!.listen(0, '127.0.0.1', resolve));
    const { port } = webhookServer!.address() as AddressInfo;
    webhookUrl = `http://127.0.0.1:${port}/hook`;
    out(`webhook listener: ${webhookUrl}`);
    return webhookUrl;
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
    const mcpUrl = process.env.MCP_URL;
    const client = new Client({ name: 'events-terminal-client', version: '1.0.0' });

    if (mcpUrl) {
        out(`connecting via HTTP: ${mcpUrl}`);
        await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    } else {
        const serverScript = process.env.MCP_SERVER_SCRIPT ?? 'src/eventsExample.ts';
        const serverArgs = process.env.MCP_SERVER_ARGS ? process.env.MCP_SERVER_ARGS.split(' ') : ['--webhook'];
        out(`connecting via stdio: spawning ${serverScript} ${serverArgs.join(' ')}`);
        await client.connect(
            new StdioClientTransport({
                command: 'pnpm',
                args: ['--filter', '@modelcontextprotocol/examples-server', 'exec', 'tsx', serverScript, ...serverArgs],
                env: { ...process.env, COREPACK_NPM_REGISTRY: 'https://registry.npmjs.org' }
            })
        );
    }

    // The manager is created eagerly with a webhook URL so any later `sub …
    // webhook` works without rebuilding. The listener references `activeManager`
    // (set below) so there's no construction-order cycle.
    const url = await ensureWebhookListener();
    const manager = new ClientEventManager(client, { webhook: { url, secret: webhookSecret } });
    activeManager = manager;
    const subs: EventSubscription[] = [];

    let quitting = false;
    const quit = async () => {
        if (quitting) return;
        quitting = true;
        out('shutting down…');
        await Promise.allSettled(subs.map(s => s.cancel()));
        await manager.close();
        webhookServer?.close();
        await client.close();
        rl.close();
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0);
    };

    const handle = async (line: string): Promise<void> => {
        const [cmd, ...rest] = line.trim().split(/\s+/);
        switch ((cmd ?? '').toLowerCase()) {
            case '': {
                return;
            }
            case 'help': {
                help();
                return;
            }
            case 'list': {
                const events = await manager.listEvents(true);
                for (const e of events) {
                    const props = e.inputSchema?.properties ? Object.keys(e.inputSchema.properties).join(', ') : '—';
                    out(`  ${e.name}  [${e.delivery.join(', ')}]  ${e.title ?? e.description ?? ''}`);
                    out(`      params: ${props}`);
                }
                return;
            }
            case 'sub': {
                const [name, modeRaw, ...tail] = rest;
                const mode = modeRaw?.toLowerCase() as EventDeliveryMode | undefined;
                if (!name || !mode || !['poll', 'push', 'webhook'].includes(mode)) {
                    out('usage: sub <name> <poll|push|webhook> [json-params] [--from <cursor>] [--max-age-ms <ms>]');
                    return;
                }
                let fromCursor: string | undefined;
                const fromIdx = tail.indexOf('--from');
                if (fromIdx !== -1) {
                    fromCursor = tail[fromIdx + 1];
                    if (!fromCursor) {
                        out('--from requires a cursor value');
                        return;
                    }
                    tail.splice(fromIdx, 2);
                }
                let maxAgeMs: number | undefined;
                const maxAgeIdx = tail.indexOf('--max-age-ms');
                if (maxAgeIdx !== -1) {
                    const raw = tail[maxAgeIdx + 1];
                    maxAgeMs = raw === undefined ? Number.NaN : Number(raw);
                    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
                        out('--max-age-ms requires a non-negative number of milliseconds');
                        return;
                    }
                    tail.splice(maxAgeIdx, 2);
                }
                let params: Record<string, unknown> = {};
                if (tail.length > 0) {
                    try {
                        params = JSON.parse(tail.join(' '));
                    } catch (error) {
                        out(`invalid JSON params: ${(error as Error).message}`);
                        return;
                    }
                }
                const sub = await manager.subscribe(name, params, { delivery: mode, cursor: fromCursor, maxAgeMs });
                subs.push(sub);
                out(
                    `subscribed #${subs.length} id=${sub.id} mode=${sub.delivery}` +
                        (fromCursor === undefined ? '' : ` from=${fromCursor}`) +
                        (maxAgeMs === undefined ? '' : ` maxAgeMs=${maxAgeMs}`)
                );
                if (sub.truncated) {
                    out(
                        `  [${sub.delivery}] ⚠ truncated — server skipped events older than retention/maxAgeMs; resuming from cursor=${sub.cursor}`
                    );
                }
                void (async () => {
                    let gotAnyEvent = false;
                    let seenTruncated = sub.truncated;
                    try {
                        for await (const ev of sub) {
                            gotAnyEvent = true;
                            if (sub.truncated && !seenTruncated) {
                                seenTruncated = true;
                                out(
                                    `  [${sub.delivery}] ⚠ truncated — gap detected; some events were dropped before cursor=${sub.cursor}`
                                );
                            }
                            printOccurrence(sub.delivery, ev);
                        }
                    } catch (error) {
                        const err = error as Error & { code?: number };
                        const label = gotAnyEvent ? 'ended' : 'REJECTED';
                        const code = err.code === undefined ? '' : ` (code ${err.code})`;
                        out(`  [${sub.delivery}] subscription ${sub.id.slice(0, 8)}… ${label}${code}: ${err.message}`);
                    } finally {
                        // Always drop dead subscriptions from the local list — covers
                        // rejection (error thrown), orderly close (iterator ends), and
                        // client-initiated cancel (unsub also calls splice, but this
                        // is a safety net).
                        const idx = subs.indexOf(sub);
                        if (idx !== -1) subs.splice(idx, 1);
                    }
                })();
                return;
            }
            case 'unsub': {
                const ref = rest[0];
                if (!ref) {
                    if (subs.length === 0) {
                        out('  (no subscriptions)');
                        return;
                    }
                    const all = [...subs];
                    subs.length = 0;
                    for (const sub of all) {
                        await sub.cancel();
                        out(`unsubscribed ${sub.id}`);
                    }
                    return;
                }
                const idx = Number.parseInt(ref, 10);
                const sub = Number.isInteger(idx) && idx >= 1 && idx <= subs.length ? subs[idx - 1] : subs.find(s => s.id === ref);
                if (!sub) {
                    out(`no such subscription: ${ref}`);
                    return;
                }
                const subIdx = subs.indexOf(sub);
                if (subIdx !== -1) subs.splice(subIdx, 1);
                await sub.cancel();
                out(`unsubscribed ${sub.id}`);
                return;
            }
            case 'subs': {
                if (subs.length === 0) {
                    out('  (none)');
                    return;
                }
                for (const [i, s] of subs.entries()) {
                    out(`  #${i + 1} ${s.id} ${s.name} [${s.delivery}] cursor=${s.cursor ?? 'null'}${s.truncated ? ' truncated' : ''}`);
                }
                return;
            }
            case 'quit':
            case 'exit': {
                await quit();
                return;
            }
            default: {
                out(`unknown command: ${cmd} (try 'help')`);
            }
        }
    };

    help();
    rl.prompt();
    rl.on('line', line => {
        void handle(line)
            .catch(error => out(`error: ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => rl.prompt());
    });
    rl.on('close', () => void quit());
}

await main();
