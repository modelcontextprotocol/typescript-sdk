/**
 * Example MCP client demonstrating the Events primitive across delivery modes.
 *
 * Connects to the `eventsExample.ts` server over stdio and subscribes to both
 * event types. The ClientEventManager handles poll loops, push streams, cursor
 * tracking, and deduplication transparently.
 *
 * Run with:
 *   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/eventsClient.ts
 *
 * Optionally force a specific delivery mode:
 *   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/eventsClient.ts --mode poll
 *   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/eventsClient.ts --mode push
 *
 * For webhook mode, start the server with `--webhook` and run this client with
 * `--mode webhook` plus a `--webhook-url <url>` that the server can POST to.
 */

import { createServer } from 'node:http';

import type { EventDeliveryMode } from '@modelcontextprotocol/client';
import {
    Client,
    ClientEventManager,
    StdioClientTransport,
    verifyWebhookSignature,
    WEBHOOK_SIGNATURE_HEADER,
    WEBHOOK_TIMESTAMP_HEADER
} from '@modelcontextprotocol/client';

const modeIdx = process.argv.indexOf('--mode');
const forcedMode = modeIdx === -1 ? undefined : (process.argv[modeIdx + 1] as EventDeliveryMode);

const webhookUrlIdx = process.argv.indexOf('--webhook-url');
const webhookUrl = webhookUrlIdx === -1 ? 'http://127.0.0.1:4000/hook' : process.argv[webhookUrlIdx + 1]!;
const webhookSecret = 'example-secret-please-change';

async function main(): Promise<void> {
    // Spawn the example server as a child process.
    const transport = new StdioClientTransport({
        command: 'pnpm',
        args: [
            '--filter',
            '@modelcontextprotocol/examples-server',
            'exec',
            'tsx',
            'src/eventsExample.ts',
            ...(forcedMode === 'webhook' ? ['--webhook'] : [])
        ]
    });

    const client = new Client({ name: 'events-example-client', version: '1.0.0' });
    await client.connect(transport);

    console.log(`Connected. Server capabilities: ${JSON.stringify(client.getServerCapabilities())}`);

    const webhookConfig =
        forcedMode === 'webhook'
            ? {
                  url: webhookUrl,
                  secret: webhookSecret
              }
            : undefined;

    const manager = new ClientEventManager(client, { webhook: webhookConfig });

    // Optional: start a local webhook receiver if using webhook mode.
    if (forcedMode === 'webhook') {
        startWebhookReceiver(manager);
    }

    // Discover available event types.
    const eventTypes = await manager.listEvents();
    console.log('\nAvailable event types:');
    for (const event of eventTypes) {
        console.log(`  ${event.name}  [${event.delivery.join(', ')}]  ${event.description ?? ''}`);
    }

    // Subscribe to the counter ticker — only even values >= 4.
    const counterSub = await manager.subscribe('counter.tick', { minValue: 4, modulo: 2 }, { delivery: forcedMode });
    console.log(`\nSubscribed to counter.tick via ${counterSub.delivery} mode (id: ${counterSub.id})`);

    // Subscribe to P1/P2 incidents.
    const incidentSub = await manager.subscribe('incident.created', { severity: 'P1' }, { delivery: forcedMode });
    console.log(`Subscribed to incident.created (P1 only) via ${incidentSub.delivery} mode (id: ${incidentSub.id})`);

    // Consume both subscriptions concurrently.
    void (async () => {
        for await (const event of counterSub) {
            console.log(`  [counter] tick #${event.data.value}  (cursor: ${event.cursor})`);
        }
    })();

    void (async () => {
        for await (const event of incidentSub) {
            console.log(`  [incident] ${event.data.incidentId}: ${event.data.title} ` + `(${event.data.severity}, ${event.data.service})`);
        }
    })();

    // Run for 60 seconds then shut down.
    await new Promise(r => setTimeout(r, 60_000));

    console.log('\nShutting down...');
    await manager.close();
    await client.close();
}

/**
 * Spins up a tiny HTTP server that verifies incoming webhook POSTs and
 * forwards them to the ClientEventManager.
 */
function startWebhookReceiver(manager: ClientEventManager): void {
    const url = new URL(webhookUrl);
    const server = createServer((req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405).end();
            return;
        }
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });
        req.on('end', () => {
            void (async () => {
                const verify = await verifyWebhookSignature(
                    webhookSecret,
                    body,
                    req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string,
                    req.headers[WEBHOOK_TIMESTAMP_HEADER.toLowerCase()] as string
                );
                if (!verify.valid) {
                    console.error(`[webhook] rejected delivery: ${verify.reason}`);
                    res.writeHead(401).end();
                    return;
                }
                manager.deliverWebhookPayload(JSON.parse(body));
                res.writeHead(200).end();
            })();
        });
    });
    server.listen(Number(url.port), url.hostname, () => {
        console.log(`Webhook receiver listening on ${webhookUrl}`);
    });
}

await main();
