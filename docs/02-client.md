---
title: Client
---

## Client overview

The SDK provides a high-level `Client` class that connects to MCP servers over different transports:

- `StdioClientTransport` – for local processes you spawn.
- `StreamableHTTPClientTransport` – for remote HTTP servers.
- `SSEClientTransport` – for legacy HTTP+SSE servers (deprecated).

Runnable client examples live under:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts)
- [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts)
- [`ssePollingClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/ssePollingClient.ts)
- [`multipleClientsParallel.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/multipleClientsParallel.ts)
- [`parallelToolCallsClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/parallelToolCallsClient.ts)

## Connecting and basic operations

A typical flow:

1. Construct a `Client` with name, version and capabilities.
2. Create a transport and call `client.connect(transport)`.
3. Use high-level helpers:
    - `listTools`, `callTool`
    - `listPrompts`, `getPrompt`
    - `listResources`, `readResource`

See [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts) for an interactive CLI client that exercises these methods and shows how to handle notifications, elicitation and tasks.

## Transports and backwards compatibility

To support both modern Streamable HTTP and legacy SSE servers, use a client that:

1. Tries `StreamableHTTPClientTransport`.
2. Falls back to `SSEClientTransport` on a 4xx response.

Runnable example:

- [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts)

## OAuth client authentication helpers

For OAuth-secured MCP servers, the client `auth` module exposes:

- `ClientCredentialsProvider`
- `PrivateKeyJwtProvider`
- `StaticPrivateKeyJwtProvider`

Examples:

- [`simpleOAuthClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClient.ts)
- [`simpleOAuthClientProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClientProvider.ts)
- [`simpleClientCredentials.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleClientCredentials.ts)
- Server-side auth demo: [`demoInMemoryOAuthProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/shared/src/demoInMemoryOAuthProvider.ts) (tests live under `examples/shared/test/demoInMemoryOAuthProvider.test.ts`)

These examples show how to:

- Perform dynamic client registration if needed.
- Acquire access tokens.
- Attach OAuth credentials to Streamable HTTP requests.
