# MCP TypeScript SDK Examples (Client)

This directory contains runnable MCP **client** examples built with `@modelcontextprotocol/client`.

For server examples, see [`../server/README.md`](../server/README.md). For guided docs, see [`../../docs/client.md`](../../docs/client.md).

## Running examples

From the repo root:

```bash
pnpm install
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleStreamableHttp.ts
```

Or, from within this package:

```bash
cd examples/client
pnpm tsx src/simpleStreamableHttp.ts
```

Most clients expect a server to be running. Start one from [`../server/README.md`](../server/README.md) (for example `src/simpleStreamableHttp.ts` in `examples/server`).

## Example index

| Scenario                                            | Description                                                                        | File                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Interactive Streamable HTTP client                  | CLI client that exercises tools/resources/prompts, notifications, and elicitation. | [`src/simpleStreamableHttp.ts`](src/simpleStreamableHttp.ts)                               |
| Backwards-compatible client (Streamable HTTP → SSE) | Tries Streamable HTTP first, falls back to legacy SSE on 4xx responses.            | [`src/streamableHttpWithSseFallbackClient.ts`](src/streamableHttpWithSseFallbackClient.ts) |
| SSE polling client (legacy)                         | Polls a legacy HTTP+SSE server and demonstrates notification handling.             | [`src/ssePollingClient.ts`](src/ssePollingClient.ts)                                       |
| Parallel tool calls                                 | Runs multiple tool calls in parallel.                                              | [`src/parallelToolCallsClient.ts`](src/parallelToolCallsClient.ts)                         |
| Multiple clients in parallel                        | Connects multiple clients concurrently to the same server.                         | [`src/multipleClientsParallel.ts`](src/multipleClientsParallel.ts)                         |
| OAuth client (interactive)                          | OAuth-enabled client (dynamic registration, auth flow).                            | [`src/simpleOAuthClient.ts`](src/simpleOAuthClient.ts)                                     |
| OAuth provider helper                               | Demonstrates reusable OAuth providers.                                             | [`src/simpleOAuthClientProvider.ts`](src/simpleOAuthClientProvider.ts)                     |
| Client credentials (M2M)                            | Machine-to-machine OAuth client credentials example.                               | [`src/simpleClientCredentials.ts`](src/simpleClientCredentials.ts)                         |
| URL elicitation client                              | Drives URL-mode elicitation flows (sensitive input in a browser).                  | [`src/elicitationUrlExample.ts`](src/elicitationUrlExample.ts)                             |
| Multi-round-trip client (2026-07-28)                | Calls a write-once tool twice: default auto-fulfilment, then manual mode.          | [`src/multiRoundTripClient.ts`](src/multiRoundTripClient.ts)                               |
| Subscriptions/listen client (2026-07-28)            | `listChanged` auto-open then manual `client.listen()`; closes after a few changes. | [`src/subscriptionsListenClient.ts`](src/subscriptionsListenClient.ts)                     |

## URL elicitation example (server + client)

Run the server first:

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/elicitationUrlExample.ts
```

Then run the client:

```bash
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/elicitationUrlExample.ts
```
