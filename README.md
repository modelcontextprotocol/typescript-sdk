# MCP TypeScript SDK

> [!IMPORTANT] **This is the `main` branch which contains v2 of the SDK (currently in development, pre-alpha).**
>
> We anticipate a stable v2 release in Q1 2026. Until then, **v1.x remains the recommended version** for production use. v1.x will continue to receive bug fixes and security updates for at least 6 months after v2 ships to give people time to upgrade.
>
> For v1 documentation and code, see the [`v1.x` branch](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fserver) ![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fclient) ![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fserver)

<details>
<summary>Table of Contents</summary>

- [Overview](#overview)
- [Packages](#packages)
- [Installation](#installation)
- [Quick Start (runnable examples)](#quick-start-runnable-examples)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

</details>

## Overview

The Model Context Protocol (MCP) allows applications to provide context for LLMs in a standardized way, separating the concerns of providing context from the actual LLM interaction.

This repository contains the TypeScript SDK implementation of the MCP specification and ships:

- MCP **server** libraries (tools/resources/prompts, Streamable HTTP, stdio, auth helpers)
- MCP **client** libraries (transports, high-level helpers, OAuth helpers)
- Optional **middleware packages** for specific runtimes/frameworks (Express, Hono, Node.js HTTP)
- Runnable **examples** (under [`examples/`](examples/))

## Packages

This monorepo publishes split packages:

- **`@modelcontextprotocol/server`**: build MCP servers
- **`@modelcontextprotocol/client`**: build MCP clients

Both packages have a **required peer dependency** on `zod` for schema validation. The SDK uses Zod v4.

### Middleware packages (optional)

The SDK also publishes small “middleware” packages under [`packages/middleware/`](packages/middleware/) that help you **wire MCP into a specific runtime or web framework**.

They are intentionally thin adapters: they should not introduce new MCP functionality or business logic. See [`packages/middleware/README.md`](packages/middleware/README.md) for details.

- **`@modelcontextprotocol/node`**: Node.js Streamable HTTP transport wrapper for `IncomingMessage` / `ServerResponse`
- **`@modelcontextprotocol/express`**: Express helpers (app defaults + Host header validation)
- **`@modelcontextprotocol/hono`**: Hono helpers (app defaults + JSON body parsing hook + Host header validation)

## Installation

### Server

```bash
npm install @modelcontextprotocol/server zod
```

### Client

```bash
npm install @modelcontextprotocol/client zod
```

### Optional middleware packages

The SDK also publishes optional “middleware” packages that help you **wire MCP into a specific runtime or web framework** (for example Express, Hono, or Node.js `http`).

These packages are intentionally thin adapters and should not introduce additional MCP features or business logic. See [`packages/middleware/README.md`](packages/middleware/README.md) for details.

```bash
# Node.js HTTP (IncomingMessage/ServerResponse) Streamable HTTP transport:
npm install @modelcontextprotocol/node

# Express integration:
npm install @modelcontextprotocol/express express

# Hono integration:
npm install @modelcontextprotocol/hono hono
```

## Quick Start (runnable examples)

The runnable examples live under `examples/` and are kept in sync with the docs.

1. **Install dependencies** (from repo root):

```bash
pnpm install
```

2. **Run a Streamable HTTP example server**:

```bash
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleStreamableHttp.ts
```

Alternatively, from within the example package:

```bash
cd examples/server
pnpm tsx src/simpleStreamableHttp.ts
```

3. **Run the interactive client in another terminal**:

```bash
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleStreamableHttp.ts
```

Alternatively, from within the example package:

```bash
cd examples/client
pnpm tsx src/simpleStreamableHttp.ts
```

Next steps:

- Server examples index: [`examples/server/README.md`](examples/server/README.md)
- Client examples index: [`examples/client/README.md`](examples/client/README.md)
- Guided walkthroughs: [`docs/server.md`](docs/server.md) and [`docs/client.md`](docs/client.md)

## Documentation

- Local SDK docs:
    - [docs/server.md](docs/server.md) – building MCP servers, transports, tools/resources/prompts, CORS, DNS rebinding, and deployment patterns.
    - [docs/client.md](docs/client.md) – using the high-level client, transports, backwards compatibility, and OAuth helpers.
    - [docs/capabilities.md](docs/capabilities.md) – sampling, elicitation (form and URL), and experimental task-based execution.
    - [docs/faq.md](docs/faq.md) – environment and troubleshooting FAQs (including Node.js Web Crypto support).
- External references:
    - [SDK API documentation](https://modelcontextprotocol.github.io/typescript-sdk/)
    - [Model Context Protocol documentation](https://modelcontextprotocol.io)
    - [MCP Specification](https://spec.modelcontextprotocol.io)
    - [Example Servers](https://github.com/modelcontextprotocol/servers)

## v1 (legacy) documentation and fixes

If you are using the **v1** generation of the SDK, the **v1 documentation** (and any v1-specific fixes) live on the long-lived [`v1.x` branch](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x). See:
[`https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x`](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

## Contributing

Issues and pull requests are welcome on GitHub at <https://github.com/modelcontextprotocol/typescript-sdk>.

## License

This project is licensed under the Apache License 2.0 for new contributions, with existing code under MIT. See the [LICENSE](LICENSE) file for details.
