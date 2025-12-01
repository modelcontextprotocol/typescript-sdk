# MCP TypeScript SDK ![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fsdk) ![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fsdk)

<details>
<summary>Table of Contents</summary>

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Examples](#examples)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

</details>

## Overview

The Model Context Protocol allows applications to provide context for LLMs in a standardized way, separating the concerns of providing context from the actual LLM interaction. This TypeScript SDK implements
[the full MCP specification](https://modelcontextprotocol.io/specification/draft), making it easy to:

- Create MCP servers that expose resources, prompts and tools
- Build MCP clients that can connect to any MCP server
- Use standard transports like stdio and Streamable HTTP

## Installation

```bash
npm install @modelcontextprotocol/sdk zod
```

This SDK has a **required peer dependency** on `zod` for schema validation. The SDK internally imports from `zod/v4`, but maintains backwards compatibility with projects using Zod v3.25 or later. You can use either API in your code by importing from `zod/v3` or `zod/v4`:

## Quick Start

To see the SDK in action end-to-end, start from the runnable examples in `src/examples`:

1. **Install dependencies** (from the SDK repo root):

    ```bash
    npm install
    ```

2. **Run the example Streamable HTTP server**:

    ```bash
    npx tsx src/examples/server/simpleStreamableHttp.ts
    ```

3. **Run the interactive client in another terminal**:

    ```bash
    npx tsx src/examples/client/simpleStreamableHttp.ts
    ```

This pair of examples demonstrates tools, resources, prompts, sampling, elicitation, tasks and logging. For a guided walkthrough and variations (stateless servers, JSON-only responses, SSE compatibility, OAuth, etc.), see [docs/server.md](docs/server.md) and
[docs/client.md](docs/client.md).

## Core Concepts

### Servers and transports

An MCP server is typically created with `McpServer` and connected to a transport such as Streamable HTTP or stdio. The SDK supports:

- **Streamable HTTP** for remote servers (recommended).
- **HTTP + SSE** for backwards compatibility only.
- **stdio** for local, process-spawned integrations.

Runnable server examples live under `src/examples/server` and are documented in [docs/server.md](docs/server.md).

### Tools, resources, prompts

- **Tools** let LLMs ask your server to take actions (computation, side effects, network calls).
- **Resources** expose read-only data that clients can surface to users or models.
- **Prompts** are reusable templates that help users talk to models in a consistent way.

The detailed APIs, including `ResourceTemplate`, completions, and display-name metadata, are covered in [docs/tools-resources-prompts.md](docs/tools-resources-prompts.md), with runnable implementations in `src/examples/server/simpleStreamableHttp.ts`.

### Sampling, elicitation, and tasks

The SDK includes higher-level capabilities for richer workflows:

- **Sampling**: server-side tools can ask connected clients to run LLM completions.
- **Form elicitation**: tools can request non-sensitive input via structured forms.
- **URL elicitation**: servers can ask users to complete secure flows in a browser (e.g., API key entry, payments, OAuth).
- **Tasks (experimental)**: long-running tool calls can be turned into tasks that you poll or resume later.

Conceptual overviews and links to runnable examples are in:

- [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md)
- [docs/tasks-and-long-running.md](docs/tasks-and-long-running.md)

Key example servers include:

- `src/examples/server/toolWithSampleServer.ts`
- `src/examples/server/elicitationFormExample.ts`
- `src/examples/server/elicitationUrlExample.ts`

### Clients

The high-level `Client` class connects to MCP servers over different transports and exposes helpers like `listTools`, `callTool`, `listResources`, `readResource`, `listPrompts`, and `getPrompt`.

Runnable clients live under `src/examples/client` and are described in [docs/client.md](docs/client.md), including:

- Interactive Streamable HTTP client (`src/examples/client/simpleStreamableHttp.ts`)
- Streamable HTTP client with SSE fallback (`src/examples/client/streamableHttpWithSseFallbackClient.ts`)
- OAuth-enabled clients and polling/parallel examples

### Node.js Web Crypto (globalThis.crypto) compatibility

Some parts of the SDK (for example, JWT-based client authentication in `auth-extensions.ts` via `jose`) rely on the Web Crypto API exposed as `globalThis.crypto`.

See [docs/faq.md](docs/faq.md) for details on supported Node.js versions and how to polyfill `globalThis.crypto` when running on older Node.js runtimes.

## Examples

The SDK ships runnable examples under `src/examples`. Use these tables to find the scenario you care about and jump straight to the corresponding code and docs.

### Server examples

| Scenario                                            | Description                                                                                       | Example file(s)                                                                                                              | Related docs                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Streamable HTTP server (stateful)                   | Feature-rich server with tools, resources, prompts, logging, tasks, sampling, and optional OAuth. | [`src/examples/server/simpleStreamableHttp.ts`](src/examples/server/simpleStreamableHttp.ts)                                 | [docs/server.md](docs/server.md), [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md), [docs/tasks-and-long-running.md](docs/tasks-and-long-running.md) |
| Streamable HTTP server (stateless)                  | No session tracking; good for simple API-style servers.                                           | [`src/examples/server/simpleStatelessStreamableHttp.ts`](src/examples/server/simpleStatelessStreamableHttp.ts)               | [docs/server.md](docs/server.md)                                                                                                                                         |
| JSON response mode (no SSE)                         | Streamable HTTP with JSON responses only and limited notifications.                               | [`src/examples/server/jsonResponseStreamableHttp.ts`](src/examples/server/jsonResponseStreamableHttp.ts)                     | [docs/server.md](docs/server.md)                                                                                                                                         |
| Server notifications over Streamable HTTP           | Demonstrates server-initiated notifications using SSE with Streamable HTTP.                       | [`src/examples/server/standaloneSseWithGetStreamableHttp.ts`](src/examples/server/standaloneSseWithGetStreamableHttp.ts)     | [docs/server.md](docs/server.md)                                                                                                                                         |
| Deprecated HTTP+SSE server                          | Legacy HTTP+SSE transport for backwards-compatibility testing.                                    | [`src/examples/server/simpleSseServer.ts`](src/examples/server/simpleSseServer.ts)                                           | [docs/server.md](docs/server.md)                                                                                                                                         |
| Backwards-compatible server (Streamable HTTP + SSE) | Single server that supports both Streamable HTTP and legacy SSE clients.                          | [`src/examples/server/sseAndStreamableHttpCompatibleServer.ts`](src/examples/server/sseAndStreamableHttpCompatibleServer.ts) | [docs/server.md](docs/server.md)                                                                                                                                         |
| Form elicitation server                             | Uses form elicitation to collect non-sensitive user input.                                        | [`src/examples/server/elicitationFormExample.ts`](src/examples/server/elicitationFormExample.ts)                             | [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md)                                                                                                     |
| URL elicitation server                              | Demonstrates URL-mode elicitation in an OAuth-protected server.                                   | [`src/examples/server/elicitationUrlExample.ts`](src/examples/server/elicitationUrlExample.ts)                               | [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md)                                                                                                     |
| Sampling and tasks server                           | Combines tools, logging, sampling, and experimental task-based execution.                         | [`src/examples/server/toolWithSampleServer.ts`](src/examples/server/toolWithSampleServer.ts)                                 | [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md), [docs/tasks-and-long-running.md](docs/tasks-and-long-running.md)                                   |
| OAuth demo authorization server                     | In-memory OAuth provider used with the example servers.                                           | [`src/examples/server/demoInMemoryOAuthProvider.ts`](src/examples/server/demoInMemoryOAuthProvider.ts)                       | [docs/server.md](docs/server.md)                                                                                                                                         |

### Client examples

| Scenario                                            | Description                                                                        | Example file(s)                                                                                                                                                                                                                                                                                    | Related docs                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Interactive Streamable HTTP client                  | CLI client that exercises tools, resources, prompts, elicitation, and tasks.       | [`src/examples/client/simpleStreamableHttp.ts`](src/examples/client/simpleStreamableHttp.ts)                                                                                                                                                                                                       | [docs/client.md](docs/client.md)                                     |
| Backwards-compatible client (Streamable HTTP → SSE) | Tries Streamable HTTP first, then falls back to SSE on 4xx responses.              | [`src/examples/client/streamableHttpWithSseFallbackClient.ts`](src/examples/client/streamableHttpWithSseFallbackClient.ts)                                                                                                                                                                         | [docs/client.md](docs/client.md), [docs/server.md](docs/server.md)   |
| SSE polling client                                  | Polls a legacy SSE server and demonstrates notification handling.                  | [`src/examples/client/ssePollingClient.ts`](src/examples/client/ssePollingClient.ts)                                                                                                                                                                                                               | [docs/client.md](docs/client.md)                                     |
| Parallel tool calls client                          | Shows how to run multiple tool calls in parallel.                                  | [`src/examples/client/parallelToolCallsClient.ts`](src/examples/client/parallelToolCallsClient.ts)                                                                                                                                                                                                 | [docs/client.md](docs/client.md)                                     |
| Multiple clients in parallel                        | Demonstrates connecting multiple clients concurrently to the same server.          | [`src/examples/client/multipleClientsParallel.ts`](src/examples/client/multipleClientsParallel.ts)                                                                                                                                                                                                 | [docs/client.md](docs/client.md)                                     |
| OAuth clients                                       | Examples of client_credentials (basic and private_key_jwt) and reusable providers. | [`src/examples/client/simpleOAuthClient.ts`](src/examples/client/simpleOAuthClient.ts), [`src/examples/client/simpleOAuthClientProvider.ts`](src/examples/client/simpleOAuthClientProvider.ts), [`src/examples/client/simpleClientCredentials.ts`](src/examples/client/simpleClientCredentials.ts) | [docs/client.md](docs/client.md)                                     |
| URL elicitation client                              | Works with the URL elicitation server to drive secure browser flows.               | [`src/examples/client/elicitationUrlExample.ts`](src/examples/client/elicitationUrlExample.ts)                                                                                                                                                                                                     | [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md) |

Shared utilities:

- In-memory event store for resumability: [`src/examples/shared/inMemoryEventStore.ts`](src/examples/shared/inMemoryEventStore.ts) (see [docs/server.md](docs/server.md)).

For more details on how to run these examples (including recommended commands and deployment diagrams), see `src/examples/README.md`.

## Documentation

- Local SDK docs:
    - [docs/server.md](docs/server.md) – building and running MCP servers, transports, CORS, DNS rebinding, and multi-node deployment.
    - [docs/client.md](docs/client.md) – using the high-level client, transports, backwards compatibility, and OAuth helpers.
    - [docs/tools-resources-prompts.md](docs/tools-resources-prompts.md) – tools, resources, prompts, completions, and display metadata.
    - [docs/sampling-and-elicitation.md](docs/sampling-and-elicitation.md) – sampling, form elicitation, and URL elicitation patterns.
    - [docs/tasks-and-long-running.md](docs/tasks-and-long-running.md) – experimental task-based execution and long-running operations.
    - [docs/faq.md](docs/faq.md) – environment and troubleshooting FAQs (including Node.js Web Crypto support).
- External references:
    - [Model Context Protocol documentation](https://modelcontextprotocol.io)
    - [MCP Specification](https://spec.modelcontextprotocol.io)
    - [Example Servers](https://github.com/modelcontextprotocol/servers)

## Contributing

Issues and pull requests are welcome on GitHub at <https://github.com/modelcontextprotocol/typescript-sdk>.

## License

This project is licensed under the MIT License—see the [LICENSE](LICENSE) file for details.
