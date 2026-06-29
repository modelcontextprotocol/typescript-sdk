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

The two protocol eras differ in how interactive tools converse with the client: on 2025-era connections the server _pushes_ `elicitation/create` / `sampling/createMessage` requests and awaits them inline; on 2026-07-28 it returns `input_required` results and the client retries the call with the answers. The interactive tools (`brainstorm_tasks`, `clear_done`, `prioritize`) implement both arms — branch on `reqCtx.era` to compare them side by side.

One serving-mode caveat: over **HTTP with a 2025-era client**, `createMcpHandler`'s default stateless posture has no return path for push-style server→client requests, so the sampling/elicitation tools refuse cleanly on that leg (stdio is unaffected; 2026-07-28 HTTP is unaffected).

## Configuration

| Env var                | Effect                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUEST_STATE_SECRET` | HMAC key for the signed `requestState` (≥ 32 bytes). Unset, the server generates a per-process random key — fine whenever a single process serves the whole flow. |
| `PORT`                 | HTTP port when `--port` isn't passed (default 3000).                                                                                                              |

## Layout

```text
server.ts   transport entry: serveStdio by default, createMcpHandler + node adapter behind --http
todos.ts    the application: state, tools, resources, prompts, subscriptions — every feature above
```

This package is intentionally **server-only**; its end-to-end coverage comes from the [`cli-client`](../cli-client/README.md) scripted e2e, which drives it across stdio + HTTP on both protocol eras in CI.
