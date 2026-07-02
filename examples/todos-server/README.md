# todos-server — the reference MCP server

A small project todo board where **every server-side MCP feature has a real job**: tools that mutate state, resources that expose it, prompts that seed conversations, sampling that borrows the connected host's model, elicitation that asks the user, progress and logs while it works, and per-resource subscriptions that announce every change. It is the workload [`cli-client`](../cli-client/README.md) (the reference host) connects to out of the box — think of it as the "polls app" of MCP servers: small enough to read in one sitting, real enough that nothing in it is contrived.

It serves **both protocol revisions at once** — 2026-07-28 and 2025-11-25 are negotiated per connection, from the same code — and **both transports**: stdio and Streamable HTTP.

## Run it

From the repo root (first time: `pnpm install && pnpm build:all`):

```bash
# stdio — for hosts that spawn their servers as child processes
pnpm --filter @mcp-examples/todos-server start

# Streamable HTTP — for remote-style connections (default port 3000; --port to change)
pnpm --filter @mcp-examples/todos-server start:http
```

Over stdio the server speaks on stdin/stdout (its own diagnostics go to stderr). Over HTTP it serves `http://127.0.0.1:3000/mcp` via `createMcpHandler`'s per-request model.

There is no era flag on the server: `serveStdio` and `createMcpHandler` detect each connection's revision during the handshake and pin the instance accordingly, so a 2025-era client and a 2026-era client can talk to the same process — simultaneously, over HTTP.

## Connect cli-client to it

```bash
# Two terminals: serve over HTTP, then point the reference host at it
pnpm --filter @mcp-examples/todos-server start:http                          # terminal A
pnpm --filter @mcp-examples/cli-client start -- --server http://127.0.0.1:3000/mcp   # terminal B

# Same, but force the 2025-era handshake on the client to see the legacy arm in action
pnpm --filter @mcp-examples/cli-client start -- --server http://127.0.0.1:3000/mcp --legacy
```

The client's status line shows what was negotiated: `connected to "todos" (2026-07-28, 8 tools, …)` vs `(2025-11-25, …)`.

You don't need the HTTP step for a quick look — running `cli-client` with no arguments spawns this server over stdio automatically.

Any other `mcpServers`-style host can spawn it too:

```jsonc
{
    "mcpServers": {
        "todos": { "command": "npx", "args": ["-y", "tsx", "/absolute/path/to/examples/todos-server/server.ts"] }
    }
}
```

## What demonstrates what

| Server feature             | Where it lives                                         | Notes                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools                      | `add_task`, `add_tasks`, `list_tasks`, `complete_task` | plain CRUD; `add_task` also returns `structuredContent` against an `outputSchema`                                                                                         |
| Sampling                   | `prioritize`, `brainstorm_tasks`                       | the server borrows the _host's_ model; the host shows the request for approval first                                                                                      |
| Elicitation (form)         | `clear_done`, `brainstorm_tasks`                       | schema-driven forms; accept / decline / cancel all handled                                                                                                                |
| Multi-round input_required | `brainstorm_tasks`                                     | theme+count form → optional custom-amount round → sampling round; state rides `requestState` as a **step-discriminated union**, HMAC-signed via `createRequestStateCodec` |
| Progress + cancellation    | `work_through_tasks`, `add_tasks`                      | paced per-task progress notifications; `work_through_tasks` checks `ctx.mcpReq.signal` between tasks and stops early when the host cancels                                |
| Logging                    | every mutating tool, via `ctx.mcpReq.log`              | honours `logging/setLevel` on 2025 connections and the per-request log-level `_meta` opt-in on 2026-07-28                                                                 |
| Resources                  | `todos://board`, `todos://tasks/{id}`                  | one concrete resource + a `ResourceTemplate` with a completion callback for task ids                                                                                      |
| Subscriptions              | the board                                              | `resources/subscribe`/`unsubscribe` handlers for 2025-era clients; `subscriptions/listen` routing for 2026-07-28; every mutation notifies                                 |
| list_changed               | every mutation                                         | resource list + resource updated notifications, delivered correctly over stdio and per-request HTTP                                                                       |
| Prompts + completions      | `plan-my-day`, `seed-board`                            | `completable()` argument values (project names, themes) wired to `completion/complete`                                                                                    |

The two protocol eras differ in how interactive conversations travel: on 2025-era connections the wire carries _pushed_ `elicitation/create` / `sampling/createMessage` requests; on 2026-07-28 the server returns `input_required` results and the client retries the call with the answers. The interactive tools (`brainstorm_tasks`, `clear_done`, `prioritize`) are written **once** in the `input_required` style — on 2025-era connections the SDK's default-on legacy shim performs the push-style round trips for them, so there is no era branch in any handler. (For a side-by-side of the two wire styles written by hand, see `examples/elicitation`.)

One serving-mode caveat: over **HTTP with a 2025-era client**, `createMcpHandler`'s default stateless posture has no return path for push-style server→client requests, so the sampling/elicitation tools refuse cleanly on that leg (stdio is unaffected; 2026-07-28 HTTP is unaffected). The **Workers entry lifts this**: `worker.ts` answers a 2025-era `initialize` with a real session — a per-session `WebStandardStreamableHTTPServerTransport` connected to a server pinned to that session — so the interactive tools work over HTTP for legacy clients too. Sessions are in-memory (each has its own transport); if the object recycles, the client gets the spec's 404 and re-initializes, and the board itself stays durable.

## Configuration

| Env var                | Effect                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUEST_STATE_SECRET` | HMAC key for the signed `requestState` (≥ 32 bytes). Unset, the server generates a per-process random key — fine whenever a single process serves the whole flow. |
| `PORT`                 | HTTP port when `--port` isn't passed (default 3000).                                                                                                              |

## Layout

```text
server.ts    transport entry (Node): serveStdio by default, createMcpHandler + node adapter behind --http
worker.ts    transport entry (Cloudflare Workers): the hosted demo — createMcpHandler's web-standard
             fetch behind a per-visitor Durable Object, plus the landing page (index.html) at /
todos.ts     the application: state, tools, resources, prompts, subscriptions — every feature above.
             createTodosApp() gives a host its own board: a buildServer factory, snapshot/restore for
             persistence, and forwardServerEvent for hosts that pin long-lived instances to a bus
```

## Live board view (Cloudflare Workers deployment)

`/board?b=<name>` is a read-only live view of a named anonymous board: the page holds an
SSE stream (`/board/events`) that the board's Durable Object feeds from the same
`ServerEventBus` every other consumer uses, so tasks appear and complete in real time as
connected agents work. Without `?b=` it shows your own address-keyed board. OAuth boards
are not viewable this way — their identity lives only inside the grant.

## OAuth (Cloudflare Workers deployment)

The worker wraps everything in [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider):
the provider is the Authorization Server (authorize/token endpoints, RFC 7591 dynamic client
registration, Client ID Metadata Documents, and both discovery documents), while the MCP
handler stays a pure Resource Server consumer. `oauth.ts` holds the whole integration:

- `propsToAuthInfo` — the canonical mapping from the provider's grant `props` to the SDK's
  `AuthInfo`. The provider attaches only `props` after verifying a token, so `clientId` and
  `scopes` are embedded at grant time; the raw token comes from the request header;
  `expiresAt` is omitted because the provider verifies the token on every request that
  reaches the API route, including session traffic — so expiry and revocation take effect
  immediately without the app tracking timestamps.
- `handleAuthorize` — the consent step. This demo has no user accounts: the principal is the
  board, and approving mints a fresh board id into the grant. A real deployment replaces
  exactly this step with its own sign-in.

Two tiers share the same board machinery: `/mcp` stays anonymous (address- or header-keyed
boards), `/oauth/mcp` serves token-authorized boards keyed by the grant (`whoami` shows which
tier a connection is on). Sessions never cross tiers: an OAuth-minted 2025-era session is
served only through the provider-verified route — every request re-verifies the token, so
expiry and revocation cut live sessions off — and a session id is never accepted as a
credential by itself. Requires the `OAUTH_KV` namespace binding (create your own:
`wrangler kv namespace create OAUTH_KV`, then replace the id in wrangler.toml) and the
`global_fetch_strictly_public` compatibility flag, which makes the platform itself guarantee
CIMD metadata fetches only reach public addresses. Setting the `TODOS_AUTO_CONSENT=1` var
auto-approves consent for scripted end-to-end runs — never set it on a real deployment.

## Deploy it (Cloudflare Workers)

`worker.ts` + `wrangler.toml` deploy this server as a public demo: `/` serves the landing page,
`/mcp` serves MCP, and every visitor gets an isolated, capped board (keyed by connecting
address, or by an `X-Todos-Board` header when the client sends one) that expires after ~2 h idle.

```bash
# from this directory
npx wrangler dev                                  # local: http://127.0.0.1:8787/mcp
npx wrangler deploy                               # deploys to <name>.<account>.workers.dev
openssl rand -base64 48 | npx wrangler secret put REQUEST_STATE_SECRET
```

The secret is optional and the default is usually better here: each board mints a key of its
own and keeps it in durable storage, so multi-round `input_required` flows survive isolate
recycling, and a leaked key compromises one board instead of every board. Set the deployment-wide
secret only when rounds must verify across boards. Boards are
capped (200 tasks; `MAX_TASKS` var to change). Treat anything on a public board as untrusted
content: boards are shared with whoever shares the visitor key.

The worker bundles the **built** packages (`dist/`, resolved through each package's exports map so
the `workerd` shims win — see `tsconfig.worker.json`); after editing `packages/*` sources, run
`pnpm build:all` before `wrangler dev`, or you'll be serving stale code.

This package is intentionally **server-only**; the Node entry's end-to-end coverage comes from the [`cli-client`](../cli-client/README.md) scripted e2e, which drives `server.ts` across stdio + HTTP on both protocol eras in CI. `worker.ts` is a deploy target, not a CI leg — exercise it with `npx wrangler dev` and the same cli-client pointed at the local URL.
