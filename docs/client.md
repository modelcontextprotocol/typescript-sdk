## Client overview

The SDK provides a high-level `Client` class that connects to MCP servers over different transports:

- `StdioClientTransport` – for local processes you spawn.
- `StreamableHTTPClientTransport` – for remote HTTP servers.
- `SSEClientTransport` – for legacy HTTP+SSE servers (deprecated).

Runnable client examples live under:

- [`simpleStreamableHttp.ts`](../src/examples/client/simpleStreamableHttp.ts)
- [`streamableHttpWithSseFallbackClient.ts`](../src/examples/client/streamableHttpWithSseFallbackClient.ts)
- [`ssePollingClient.ts`](../src/examples/client/ssePollingClient.ts)
- [`multipleClientsParallel.ts`](../src/examples/client/multipleClientsParallel.ts)
- [`parallelToolCallsClient.ts`](../src/examples/client/parallelToolCallsClient.ts)

## Connecting and basic operations

A typical flow:

1. Construct a `Client` with name, version and capabilities.
2. Create a transport and call `client.connect(transport)`.
3. Use high-level helpers:
    - `listTools`, `callTool`
    - `listPrompts`, `getPrompt`
    - `listResources`, `readResource`

See [`simpleStreamableHttp.ts`](../src/examples/client/simpleStreamableHttp.ts) for an interactive CLI client that exercises these methods and shows how to handle notifications, elicitation and tasks.

## Transports and backwards compatibility

To support both modern Streamable HTTP and legacy SSE servers, use a client that:

1. Tries `StreamableHTTPClientTransport`.
2. Falls back to `SSEClientTransport` on a 4xx response.

Runnable example:

- [`streamableHttpWithSseFallbackClient.ts`](../src/examples/client/streamableHttpWithSseFallbackClient.ts)

## OAuth client authentication helpers

For OAuth-secured MCP servers, the client `auth` module exposes:

- `ClientCredentialsProvider`
- `PrivateKeyJwtProvider`
- `StaticPrivateKeyJwtProvider`

Examples:

- [`simpleOAuthClient.ts`](../src/examples/client/simpleOAuthClient.ts)
- [`simpleOAuthClientProvider.ts`](../src/examples/client/simpleOAuthClientProvider.ts)
- [`simpleClientCredentials.ts`](../src/examples/client/simpleClientCredentials.ts)
- Server-side auth demo: [`demoInMemoryOAuthProvider.ts`](../src/examples/server/demoInMemoryOAuthProvider.ts) (tests live under `test/examples/server/demoInMemoryOAuthProvider.test.ts`)

These examples show how to:

- Perform dynamic client registration if needed.
- Acquire access tokens.
- Attach OAuth credentials to Streamable HTTP requests.
