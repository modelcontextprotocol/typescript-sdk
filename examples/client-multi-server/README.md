# Multi-Server Routing Example

Minimal example showing how to connect to multiple MCP servers and route tool calls to the correct one.

Spawns two in-repo servers (`server-quickstart` and `mcpServerOutputSchema`), discovers their tools, builds a prefixed routing table, and calls one tool on each server to demonstrate the routing.

No API key required. No external config file needed.

## Quick Start

```bash
# Install dependencies (from repo root)
pnpm install

# Run the example
npx tsx examples/client-multi-server/src/index.ts
```

## How It Works

1. Spawns each server as a child process via `StdioClientTransport`
2. Connects a `Client` to each and calls `listTools()` to discover available tools
3. Builds a routing map that prefixes each tool name with its server name (e.g. `weather-nws__get-alerts`) to avoid collisions
4. Calls one tool on each server to prove routing works
5. Cleans up all connections

## Adapting This Pattern

To route tool calls in your own multi-server setup:

- Prefix tool names with the server name when presenting them to an LLM
- When the LLM calls a prefixed tool, strip the prefix and forward to the correct server
- Check for collisions if multiple servers expose tools with the same name
