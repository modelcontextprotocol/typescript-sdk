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

| Scenario                                            | Description                                                                               | File                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Interactive Streamable HTTP client                  | CLI client that exercises tools/resources/prompts, notifications, elicitation, and tasks. | [`src/simpleStreamableHttp.ts`](src/simpleStreamableHttp.ts)                               |
| Backwards-compatible client (Streamable HTTP → SSE) | Tries Streamable HTTP first, falls back to legacy SSE on 4xx responses.                   | [`src/streamableHttpWithSseFallbackClient.ts`](src/streamableHttpWithSseFallbackClient.ts) |
| SSE polling client (legacy)                         | Polls a legacy HTTP+SSE server and demonstrates notification handling.                    | [`src/ssePollingClient.ts`](src/ssePollingClient.ts)                                       |
| Parallel tool calls                                 | Runs multiple tool calls in parallel.                                                     | [`src/parallelToolCallsClient.ts`](src/parallelToolCallsClient.ts)                         |
| Multiple clients in parallel                        | Connects multiple clients concurrently to the same server.                                | [`src/multipleClientsParallel.ts`](src/multipleClientsParallel.ts)                         |
| OAuth client (interactive)                          | OAuth-enabled client (dynamic registration, auth flow).                                   | [`src/simpleOAuthClient.ts`](src/simpleOAuthClient.ts)                                     |
| OAuth provider helper                               | Demonstrates reusable OAuth providers.                                                    | [`src/simpleOAuthClientProvider.ts`](src/simpleOAuthClientProvider.ts)                     |
| Client credentials (M2M)                            | Machine-to-machine OAuth client credentials example.                                      | [`src/simpleClientCredentials.ts`](src/simpleClientCredentials.ts)                         |
| URL elicitation client                              | Drives URL-mode elicitation flows (sensitive input in a browser).                         | [`src/elicitationUrlExample.ts`](src/elicitationUrlExample.ts)                             |
| Task interactive client                             | Demonstrates task-based execution + interactive server→client requests.                   | [`src/simpleTaskInteractiveClient.ts`](src/simpleTaskInteractiveClient.ts)                 |

## URL elicitation example (server + client)

Run the server first:

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/elicitationUrlExample.ts
```

Then run the client:

```bash
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/elicitationUrlExample.ts
```
