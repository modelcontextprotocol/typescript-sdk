/**
 * Stripe — MCP Events server (production-ready).
 *
 * Exposes Stripe `invoice.payment_failed` and `customer.subscription.deleted`
 * events over the MCP Events primitive using a dual-path delivery model: a
 * durable poll cursor against Stripe's `/v1/events` API plus a low-latency
 * webhook ingress that broadcasts via `emitEvent()`. Clients see whichever
 * path delivers first and dedupe on the Stripe event id carried in each
 * payload.
 *
 * ## Setup
 *
 * 1. Get test API keys at https://dashboard.stripe.com/test/apikeys and set
 *    `STRIPE_SECRET_KEY` to the secret key (`sk_test_...`).
 * 2. Start a local webhook forwarder with the Stripe CLI:
 *      stripe listen --forward-to localhost:3000/stripe/webhook
 *    Copy the printed signing secret (`whsec_...`) into
 *    `STRIPE_WEBHOOK_SECRET`.
 * 3. Trigger test events from another terminal:
 *      stripe trigger invoice.payment_failed
 *      stripe trigger customer.subscription.deleted
 *
 * ## Environment variables
 *
 * | Name                   | Description                                      |
 * |------------------------|--------------------------------------------------|
 * | STRIPE_SECRET_KEY      | Stripe secret API key (`sk_test_...`)            |
 * | STRIPE_WEBHOOK_SECRET  | Webhook signing secret (`whsec_...`)             |
 * | PORT                   | Webhook listener port (default `3000`)           |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/stripe.ts
 *
 * ## Known gap
 *
 * The SDK currently auto-generates `eventId` per delivery, so the same Stripe
 * occurrence arriving via webhook and via poll carries two distinct MCP
 * `eventId`s. We work around this by including the upstream Stripe `evt_...`
 * id in `data.stripeEventId` — clients must dedupe on that field, not on the
 * MCP-level `eventId`.
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import express from 'express';
import Stripe from 'stripe';
import * as z from 'zod/v4';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// Map Stripe event types -> MCP event names.
const STRIPE_TO_MCP: Record<string, string> = {
    'invoice.payment_failed': 'stripe.invoice_payment_failed',
    'customer.subscription.deleted': 'stripe.customer_subscription_deleted'
};

function toPayload(e: Stripe.Event, expand: boolean): Record<string, unknown> {
    const obj = e.data.object as unknown as Record<string, unknown>;
    return {
        // Upstream Stripe event id — the dedup key across the webhook and poll
        // paths (SDK's own eventId differs per delivery; see Known gap above).
        stripeEventId: e.id,
        created: e.created,
        object: expand ? obj : { id: obj.id, object_type: e.type.split('.')[0] }
    };
}

export function createServer(stripeOverride?: Stripe): McpServer {
    const secretKey = stripeOverride ? '' : requireEnv('STRIPE_SECRET_KEY');
    const webhookSecret = stripeOverride ? '' : requireEnv('STRIPE_WEBHOOK_SECRET');
    const port = Number(process.env.PORT ?? 3000);

    const stripe = stripeOverride ?? new Stripe(secretKey);

    const server = new McpServer({ name: 'stripe-events', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 15_000 } } });

    const inputSchema = z.object({
        expand: z.boolean().default(false).describe('If true, embed the full Stripe object in each event payload')
    });
    const payloadSchema = z.object({
        stripeEventId: z.string().describe('Stripe event id (evt_...). Dedupe on this across delivery paths.'),
        created: z.number(),
        object: z.record(z.string(), z.unknown())
    });

    // Check callback: durable cursor against GET /v1/events.
    //
    // Stripe lists events newest-first. `ending_before: <id>` returns events
    // NEWER than <id> (still newest-first). We reverse to oldest-first so the
    // last element's id becomes the next cursor. `has_more` means another
    // newer page exists and the client should poll again immediately.
    const check =
        (stripeType: string, mcpName: string) =>
        async ({ expand }: { expand: boolean }, cursor: string | null) => {
            if (cursor === null) {
                // Bootstrap: anchor at the newest existing event for this type.
                const head = await stripe.events.list({ types: [stripeType], limit: 1 });
                const latest = head.data[0]?.id ?? `bootstrap:${Date.now()}`;
                return { events: [], cursor: latest, nextPollSeconds: 10 };
            }
            // Synthetic bootstrap cursor — nothing to page before yet.
            if (cursor.startsWith('bootstrap:')) {
                const head = await stripe.events.list({ types: [stripeType], limit: 1 });
                const first = head.data[0];
                if (!first) return { events: [], cursor, nextPollSeconds: 10 };
                // Re-enter with a real event id so ending_before works next tick.
                return {
                    events: [{ name: mcpName, data: toPayload(first, expand) }],
                    cursor: first.id,
                    hasMore: false,
                    nextPollSeconds: 10
                };
            }
            const page = await stripe.events.list({
                types: [stripeType],
                ending_before: cursor,
                limit: 100
            });
            const chronological = page.data.toReversed();
            return {
                events: chronological.map(e => ({ name: mcpName, data: toPayload(e, expand) })),
                cursor: chronological.at(-1)?.id ?? cursor,
                hasMore: page.has_more,
                nextPollSeconds: 10
            };
        };

    for (const [stripeType, mcpName] of Object.entries(STRIPE_TO_MCP)) {
        server.registerEvent(
            mcpName,
            {
                description: `Stripe ${stripeType} events (dual-path: webhook emit + /v1/events poll)`,
                inputSchema,
                payloadSchema,
                // Broadcast emits from the webhook path must reach poll clients too.
                buffer: { capacity: 1000 },
                matches: () => true // webhook handler already filters by type
            },
            check(stripeType, mcpName)
        );
    }

    // --- Webhook ingress (low-latency path) ----------------------------------
    // Skip when a test override is injected.
    if (!stripeOverride) {
        const app = express();
        app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
            const sig = req.headers['stripe-signature'];
            if (!sig) {
                res.status(400).send('Missing stripe-signature header');
                return;
            }
            let evt: Stripe.Event;
            try {
                evt = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                res.status(400).send(`Webhook signature verification failed: ${msg}`);
                return;
            }
            const mcpName = STRIPE_TO_MCP[evt.type];
            if (mcpName) {
                // NOTE: emitEvent() broadcasts one payload to all subscribers, so
                // we cannot honour each subscriber's `expand` param here. Emit the
                // fat payload; thin-mode subscribers still receive it.
                server.emitEvent(mcpName, toPayload(evt, true));
            }
            res.json({ received: true });
        });
        app.listen(port, () => {
            console.error(`stripe webhook listener on http://localhost:${port}/stripe/webhook`);
        });
    }

    return server;
}

// --- main --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('stripe MCP server running on stdio');
}
