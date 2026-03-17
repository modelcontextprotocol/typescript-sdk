# Multi-Server MCP Client Example

A CLI chatbot that connects to multiple MCP servers simultaneously, aggregates their tools, and routes tool calls to the correct server. This is the TypeScript equivalent of the [Python SDK's simple-chatbot example](https://github.com/modelcontextprotocol/python-sdk/tree/main/examples/clients/simple-chatbot).

## Prerequisites

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com/)

## Quick Start

```bash
# Install dependencies (from repo root)
pnpm install

# Set your API key
export ANTHROPIC_API_KEY=your-api-key-here

# Run with the default servers.json config
cd examples/client-multi-server
npx tsx src/index.ts
```

## Configuration

Servers are configured via a JSON file (default: `servers.json` in the working directory). Pass a custom path as the first argument:

```bash
npx tsx src/index.ts /path/to/my-servers.json
```

The config file uses the same format as Claude Desktop and other MCP clients:

```json
{
    "mcpServers": {
        "everything": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-everything"]
        },
        "memory": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
    }
}
```

Each entry under `mcpServers` defines a server to connect to via stdio:

- `command`: the executable to run
- `args`: command-line arguments (optional)
- `env`: additional environment variables (optional, merged with the current environment)

## How It Works

1. Reads the server config and connects to each MCP server in sequence
2. Discovers tools from every connected server and builds a unified tool list
3. Maintains a mapping from each tool name to its originating server
4. Sends the full tool list to Claude with each request
5. When Claude calls a tool, routes the call to the correct server
6. Supports multi-step tool use (agentic loop) where Claude can chain multiple tool calls

## Usage

```
$ npx tsx src/index.ts
Connecting to server: everything...
  Connected to everything with tools: echo, add, ...

Total tools available: 12

Multi-Server MCP Client Started!
Type your queries or "quit" to exit.

Query: What tools do you have access to?

I have access to 12 tools from the "everything" server...

Query: quit
Disconnecting from everything...
```
