# MCP Events — Real-World Integration Examples

Seven production-ready MCP servers demonstrating the Events primitive against real upstream data sources. Each server is deployable as-is once you provide credentials via environment variables.

## Quick start

```sh
# Install dependencies (from repo root)
pnpm install

# Run any server (replace <source> with gmail, slack, github, kubernetes, stripe, shopify, or discord)
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/<source>.ts
```

Each server reads configuration from environment variables. See the top-of-file comment in each `.ts` file for the specific variables and setup steps required.

## Servers

| Source                           | Pattern                                       | Upstream SDK              | Requires public URL?     |
| -------------------------------- | --------------------------------------------- | ------------------------- | ------------------------ |
| [gmail.ts](./gmail.ts)           | Poll `history.list` with `historyId` cursor   | `googleapis`              | No                       |
| [slack.ts](./slack.ts)           | Socket Mode WS → `emitEvent`                  | `@slack/socket-mode`      | No                       |
| [github.ts](./github.ts)         | Inbound webhook → `emitEvent`                 | `@octokit/webhooks`       | Yes (ngrok/cloudflared)  |
| [kubernetes.ts](./kubernetes.ts) | List-then-watch with `resourceVersion` cursor | `@kubernetes/client-node` | No                       |
| [stripe.ts](./stripe.ts)         | Dual: `/v1/events` poll + webhook             | `stripe`                  | Yes (or `stripe listen`) |
| [shopify.ts](./shopify.ts)       | Inbound webhook → `emitEvent`                 | `@shopify/shopify-api`    | Yes (ngrok/cloudflared)  |
| [discord.ts](./discord.ts)       | Gateway WS → `emitEvent`                      | `discord.js`              | No                       |

## Exposing a public URL for webhook sources

GitHub, Stripe, and Shopify need to POST webhooks to your server. For local development, tunnel a local port:

```sh
# Option A: cloudflared (no account needed)
cloudflared tunnel --url http://localhost:3000

# Option B: ngrok
ngrok http 3000

# Option C (Stripe only): stripe CLI forwarding
stripe listen --forward-to localhost:3000/stripe/webhook
```

Copy the public URL into the upstream's webhook configuration.

## Common environment variable patterns

All servers follow these conventions:

- `<SOURCE>_*` prefix for all variables (e.g. `STRIPE_SECRET_KEY`, `SLACK_BOT_TOKEN`)
- `PORT` for the inbound webhook HTTP listener (defaults to `3000`)
- Missing required variables cause a clear error at startup, not a silent failure

## Testing without credentials

Each server's `createServer()` export accepts an optional client override for unit testing. The integration tests in `test/integration/` use this to inject mocks.
