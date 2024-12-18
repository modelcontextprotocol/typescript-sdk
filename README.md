# MCP TypeScript SDK ![NPM Version](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fsdk)

TypeScript implementation of the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), providing both client and server capabilities for integrating with LLM surfaces.

## Overview

The Model Context Protocol allows applications to provide context for LLMs in a standardized way, separating the concerns of providing context from the actual LLM interaction. This TypeScript SDK implements the full MCP specification, making it easy to:

- Build MCP clients that can connect to any MCP server
- Create MCP servers that expose resources, prompts and tools
- Use standard transports like stdio and SSE
- Handle all MCP protocol messages and lifecycle events

## Installation

```bash
npm install @modelcontextprotocol/sdk
```

## Quick Start

### Creating a Client

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const transport = new StdioClientTransport({
  command: "path/to/server",
});

const client = new Client({
  name: "example-client",
  version: "1.0.0",
}, {
  capabilities: {}
});

await client.connect(transport);

// List available resources
const resources = await client.request(
  { method: "resources/list" },
  ListResourcesResultSchema
);

// Read a specific resource
const resourceContent = await client.request(
  {
    method: "resources/read",
    params: {
      uri: "file:///example.txt"
    }
  },
  ReadResourceResultSchema
);
```

### Creating a Server

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({
  name: "example-server",
  version: "1.0.0",
}, {
  capabilities: {
    resources: {}
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "file:///example.txt",
        name: "Example Resource",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "file:///example.txt") {
    return {
      contents: [
        {
          uri: "file:///example.txt",
          mimeType: "text/plain",
          text: "This is the content of the example resource.",
        },
      ],
    };
  } else {
    throw new Error("Resource not found");
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Documentation

- [Model Context Protocol documentation](https://modelcontextprotocol.io)
- [MCP Specification](https://spec.modelcontextprotocol.io)
- [Example Servers](https://github.com/modelcontextprotocol/servers)

## Contributing

Issues and pull requests are welcome on GitHub at https://github.com/modelcontextprotocol/typescript-sdk.

## License

This project is licensed under the MIT License—see the [LICENSE](LICENSE) file for details.
