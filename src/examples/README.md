# MCP TypeScript SDK Examples

This directory contains example implementations of MCP clients and servers using the TypeScript SDK.

## Streamable HTTP - single node deployment with basic session state management

Multi node with stete management example will be added soon after we add support.

### Server (`server/simpleStreamableHttp.ts`)

A simple MCP server that uses the Streamable HTTP transport, implemented with Express. The server provides:

- A simple `greet` tool that returns a greeting for a name
- A `greeting-template` prompt that generates a greeting template
- A static `greeting-resource` resource

#### Running the server

```bash
npx tsx src/examples/server/simpleStreamableHttp.ts
```

The server will start on port 3000. You can test the initialization and tool listing:

```bash
# First initialize the server and save the session ID to a variable
SESSION_ID=$(curl -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":"1"}' \
  -i http://localhost:3000/mcp 2>&1 | grep -i "mcp-session-id" | cut -d' ' -f2 | tr -d '\r')
echo "Session ID: $SESSION_ID"

# Then list tools using the saved session ID 
curl -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":"2"}' \
  http://localhost:3000/mcp
```

### Client (`client/simpleStreamableHttp.ts`)

A client that connects to the server, initializes it, and demonstrates how to:

- List available tools and call the `greet` tool
- List available prompts and get the `greeting-template` prompt
- List available resources

#### Running the client

```bash
npx tsx src/examples/client/simpleStreamableHttp.ts
```

Make sure the server is running before starting the client.

## Notes

- These examples demonstrate the basic usage of the Streamable HTTP transport
- The server manages sessions between the calls
- The client handles both direct HTTP responses and SSE streaming responses
