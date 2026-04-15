/**
 * Shopify — MCP Events server (production-ready).
 *
 * Exposes Shopify store events as MCP events via inbound webhooks. Registers
 * `shopify.order_created` (fires when a customer places an order) and
 * `shopify.customer_redact` (the mandatory GDPR erasure webhook). An embedded
 * Express listener receives Shopify's webhook POSTs, verifies the HMAC
 * signature using the official SDK, and forwards each payload to MCP
 * subscribers via `emitEvent`. Webhook registrations are reconciled on startup
 * and every 10 minutes to recover from Shopify's silent auto-deregistration
 * after repeated 5xx responses.
 *
 * ## Setup
 *
 * 1. Create a Partner account at https://partners.shopify.com
 * 2. Create a development store from the Partner dashboard
 * 3. In the store admin, go to **Settings → Apps and sales channels →
 *    Develop apps → Create an app**. Grab the API key (client ID) and API
 *    secret. Under **Admin API access scopes** enable `read_orders` and
 *    `write_webhooks`, then install the app to get an Admin API access token.
 * 4. Expose a public URL for the webhook listener:
 *      cloudflared tunnel --url http://localhost:3000
 * 5. Set `SHOPIFY_HOST` to the tunnel hostname (no protocol). This server
 *    self-registers the `orders/create` webhook at `<host>/shopify/webhook`.
 * 6. GDPR webhooks (customers/redact etc.) **cannot** be registered via API —
 *    configure them in the Partner dashboard under **App setup → Compliance
 *    webhooks**, pointing at `https://<host>/shopify/webhook`.
 *
 * ## Environment variables
 *
 * | Variable               | Description                                          |
 * |------------------------|------------------------------------------------------|
 * | `SHOPIFY_API_KEY`      | App client ID from the Partner dashboard             |
 * | `SHOPIFY_API_SECRET`   | App client secret (used for webhook HMAC verify)     |
 * | `SHOPIFY_SHOP`         | Shop domain, e.g. `mystore.myshopify.com`            |
 * | `SHOPIFY_ACCESS_TOKEN` | Admin API access token for the installed custom app  |
 * | `SHOPIFY_HOST`         | Public hostname of this server (tunnel URL, no `https://`) |
 * | `PORT`                 | HTTP listener port (default `3000`)                  |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/shopify.ts
 */

import '@shopify/shopify-api/adapters/node';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import type { Shopify } from '@shopify/shopify-api';
import { DeliveryMethod, LATEST_API_VERSION, Session, shopifyApi } from '@shopify/shopify-api';
import express from 'express';
import * as z from 'zod/v4';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// --- Payload schemas (minimal projections of Shopify's webhook bodies) ------

const OrderPayload = z.object({
    id: z.number(),
    order_number: z.number(),
    total_price: z.string(),
    currency: z.string(),
    email: z.string().nullable(),
    created_at: z.string(),
    customer_id: z.number().nullable()
});
type OrderPayload = z.infer<typeof OrderPayload>;

const RedactPayload = z.object({
    shop_id: z.number(),
    shop_domain: z.string(),
    customer: z.object({ id: z.number(), email: z.string().optional() }),
    orders_to_redact: z.array(z.number())
});
type RedactPayload = z.infer<typeof RedactPayload>;

// --- Server factory ---------------------------------------------------------

export function createServer(shopifyOverride?: Shopify): McpServer {
    const shop = requireEnv('SHOPIFY_SHOP');
    const host = requireEnv('SHOPIFY_HOST');
    const port = Number(process.env.PORT ?? 3000);

    const shopify =
        shopifyOverride ??
        shopifyApi({
            apiKey: requireEnv('SHOPIFY_API_KEY'),
            apiSecretKey: requireEnv('SHOPIFY_API_SECRET'),
            adminApiAccessToken: requireEnv('SHOPIFY_ACCESS_TOKEN'),
            scopes: ['read_orders', 'write_webhooks'],
            hostName: host,
            apiVersion: LATEST_API_VERSION,
            isEmbeddedApp: false,
            isCustomStoreApp: true
        });

    // Offline session for a custom store app: no OAuth dance, just the token.
    const session = new Session({
        id: `offline_${shop}`,
        shop,
        state: '',
        isOnline: false,
        accessToken: requireEnv('SHOPIFY_ACCESS_TOKEN')
    });

    const server = new McpServer({ name: 'shopify-events', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 15_000 } } });

    // --- Webhook registration lifecycle -------------------------------------
    //
    // SDK note: @shopify/shopify-api has no explicit `unregister`. Its
    // `webhooks.register({session})` call *reconciles* the local handler
    // registry against Shopify — creating, updating, or deleting subscriptions
    // to match. The registry is additive-only (no removeHandlers), so once
    // ORDERS_CREATE is added we keep it registered upstream for the server's
    // lifetime. That's fine: inbound webhooks with zero MCP subscribers just
    // hit a no-op emitEvent. We still refcount for observability.

    shopify.webhooks.addHandlers({
        ORDERS_CREATE: {
            deliveryMethod: DeliveryMethod.Http,
            callbackUrl: '/shopify/webhook'
        }
        // CUSTOMERS_REDACT is a privacy topic — must be set in the Partner
        // dashboard, the Admin API rejects it. We still handle it below.
    });

    let orderSubscribers = 0;

    async function reconcileWebhooks(): Promise<void> {
        try {
            const result = await shopify.webhooks.register({ session });
            for (const [topic, ops] of Object.entries(result)) {
                for (const op of ops) {
                    if (op.success) {
                        console.error(`[shopify] webhook ${op.operation} ok for ${topic}`);
                    } else {
                        console.error(`[shopify] webhook ${op.operation} FAILED for ${topic}:`, op.result);
                    }
                }
            }
        } catch (error) {
            console.error('[shopify] webhook reconcile error:', error);
        }
    }

    server.registerEvent(
        'shopify.order_created',
        {
            description: 'Fires when a new order is placed in the connected Shopify store',
            inputSchema: z.object({
                minTotal: z.number().default(0).describe('Only deliver orders with total_price >= this value')
            }),
            payloadSchema: OrderPayload,
            matches: (params, data) => Number((data as OrderPayload).total_price) >= params.minTotal,
            buffer: { capacity: 500 },
            hooks: {
                onSubscribe: async () => {
                    if (orderSubscribers++ === 0) {
                        console.error('[shopify] first order subscriber — ensuring webhook registered');
                        await reconcileWebhooks();
                    }
                },
                onUnsubscribe: async () => {
                    if (--orderSubscribers === 0) {
                        console.error('[shopify] last order subscriber gone (webhook stays registered — SDK has no unregister)');
                    }
                }
            }
        },
        // emit-only: no upstream cursor API for orders. buffer handles poll.
        async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 })
    );

    server.registerEvent(
        'shopify.customer_redact',
        {
            description: 'GDPR mandatory webhook: customer requested data erasure',
            inputSchema: z.object({}),
            payloadSchema: RedactPayload,
            buffer: { capacity: 100 }
            // No hooks: privacy webhooks are configured in the Partner dashboard
            // and cannot be (de)registered via the Admin API.
        },
        async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 60 })
    );

    // --- Inbound webhook HTTP listener --------------------------------------

    const app = express();
    app.post('/shopify/webhook', express.text({ type: '*/*' }), (req, res) => {
        void (async () => {
            const rawBody = req.body as string;
            const check = await shopify.webhooks.validate({ rawBody, rawRequest: req, rawResponse: res });

            if (!check.valid) {
                console.error(`[shopify] webhook rejected: ${check.reason}`);
                res.status(401).send('invalid webhook');
                return;
            }

            // MUST respond 200 within 5s or Shopify counts a failure toward
            // the ~19-strikes auto-deregister threshold. Ack first, process after.
            res.status(200).send('ok');

            const payload = JSON.parse(rawBody);
            switch (check.topic) {
                case 'ORDERS_CREATE': {
                    server.emitEvent('shopify.order_created', {
                        id: payload.id,
                        order_number: payload.order_number,
                        total_price: payload.total_price,
                        currency: payload.currency,
                        email: payload.email ?? null,
                        created_at: payload.created_at,
                        customer_id: payload.customer?.id ?? null
                    });
                    break;
                }
                case 'CUSTOMERS_REDACT': {
                    // GDPR: MUST handle even with zero MCP subscribers. emitEvent
                    // with no listeners is a no-op on the SDK side; log for audit.
                    console.error(`[shopify] GDPR redact request: customer ${payload.customer?.id} on ${payload.shop_domain}`);
                    server.emitEvent('shopify.customer_redact', RedactPayload.parse(payload));
                    // Real compliance action goes here:
                    //   await yourDataStore.redactCustomer(payload.customer.id);
                    break;
                }
                default: {
                    console.error(`[shopify] unhandled webhook topic: ${check.topic}`);
                }
            }
        })().catch(error => {
            console.error('[shopify] webhook handler error:', error);
            if (!res.headersSent) res.status(500).send('error');
        });
    });

    const httpServer = app.listen(port, () => {
        console.error(`[shopify] webhook listener on :${port}/shopify/webhook`);
    });

    // --- Auto-re-registration loop ------------------------------------------
    // Shopify drops webhooks after ~19 consecutive 5xx over 48h with no
    // notification. Reconcile on boot and every 10 minutes.

    void reconcileWebhooks();
    const reconcileTimer = setInterval(() => void reconcileWebhooks(), 10 * 60 * 1000);

    server.server.onclose = () => {
        clearInterval(reconcileTimer);
        httpServer.close();
    };

    return server;
}

// --- main -------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('shopify MCP server running on stdio');
}
