# MCP TypeScript SDK

![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%server) ![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%client) ![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%server)

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
- Runnable **examples** (under [`examples/`](examples/))

## Packages

This monorepo publishes split packages:

- **`@modelcontextprotocol/server`**: build MCP servers
- **`@modelcontextprotocol/client`**: build MCP clients

Both packages have a **required peer dependency** on `zod` for schema validation. The SDK internally imports from `zod/v4`, but remains compatible with projects using Zod v3.25+.

## Installation

### Server

```bash
npm install @modelcontextprotocol/server zod
```

### Client

```bash
npm install @modelcontextprotocol/client zod
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
    - [Model Context Protocol documentation](https://modelcontextprotocol.io)
    - [MCP Specification](https://spec.modelcontextprotocol.io)
    - [Example Servers](https://github.com/modelcontextprotocol/servers)

## v1 (legacy) documentation and fixes

If you are using the **v1** generation of the SDK, the **v1 documentation** (and any v1-specific fixes) live on the long-lived [`v1.x` branch](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x). See:
[`https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x`](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

## Contributing

Issues and pull requests are welcome on GitHub at <https://github.com/modelcontextprotocol/typescript-sdk>.

## License

This project is licensed under the MIT License—see the [LICENSE](LICENSE) file for details.
