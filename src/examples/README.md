# MCP TypeScript SDK Examples

This directory contains example implementations of MCP clients and servers using the TypeScript SDK.

## Table of Contents

- [Client Implementations](#client-implementations)
    - [Streamable HTTP Client](#streamable-http-client)
    - [Backwards Compatible Client](#backwards-compatible-client)
- [Server Implementations](#server-implementations)
    - [Single Node Deployment](#single-node-deployment)
        - [Streamable HTTP Transport](#streamable-http-transport)
        - [Deprecated SSE Transport](#deprecated-sse-transport)
        - [Backwards Compatible Server](#streamable-http-backwards-compatible-server-with-sse)
    - [Multi-Node Deployment](#multi-node-deployment)
- [Backwards Compatibility](#testing-streamable-http-backwards-compatibility-with-sse)

## Client Implementations

### Streamable HTTP Client

A full-featured interactive client that connects to a Streamable HTTP server, demonstrating how to:

- Establish and manage a connection to an MCP server
- List and call tools with arguments
- Handle notifications through the SSE stream
- List and get prompts with arguments
- List available resources
- Handle session termination and reconnection
- Support for resumability with Last-Event-ID tracking

```bash
npx tsx src/examples/client/simpleStreamableHttp.ts
```

Example client with OAuth:

```bash
npx tsx src/examples/client/simpleOAuthClient.js
```

### Backwards Compatible Client

A client that implements backwards compatibility according to the [MCP specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#backwards-compatibility), allowing it to work with both new and legacy servers. This client demonstrates:

- The client first POSTs an initialize request to the server URL:
    - If successful, it uses the Streamable HTTP transport
    - If it fails with a 4xx status, it attempts a GET request to establish an SSE stream

```bash
npx tsx src/examples/client/streamableHttpWithSseFallbackClient.ts
```

## Server Implementations

### Single Node Deployment

These examples demonstrate how to set up an MCP server on a single node with different transport options.

#### Streamable HTTP Transport

##### Simple Streamable HTTP Server

A server that implements the Streamable HTTP transport (protocol version 2025-03-26).

- Basic server setup with Express and the Streamable HTTP transport
- Session management with an in-memory event store for resumability
- Tool implementation with the `greet` and `multi-greet` tools
- Prompt implementation with the `greeting-template` prompt
- Static resource exposure
- Support for notifications via SSE stream established by GET requests
- Session termination via DELETE requests

```bash
npx tsx src/examples/server/simpleStreamableHttp.ts

# To add a demo of authentication to this example, use:
npx tsx src/examples/server/simpleStreamableHttp.ts --oauth

# To mitigate impersonation risks, enable strict Resource Identifier verification:
npx tsx src/examples/server/simpleStreamableHttp.ts --oauth --oauth-strict
```

##### JSON Response Mode Server

A server that uses Streamable HTTP transport with JSON response mode enabled (no SSE).

- Streamable HTTP with JSON response mode, which returns responses directly in the response body
- Limited support for notifications (since SSE is disabled)
- Proper response handling according to the MCP specification for servers that don't support SSE
- Returning appropriate HTTP status codes for unsupported methods

```bash
npx tsx src/examples/server/jsonResponseStreamableHttp.ts
```

##### Streamable HTTP with server notifications

A server that demonstrates server notifications using Streamable HTTP.

- Resource list change notifications with dynamically added resources
- Automatic resource creation on a timed interval

```bash
npx tsx src/examples/server/standaloneSseWithGetStreamableHttp.ts
```

#### Deprecated SSE Transport

A server that implements the deprecated HTTP+SSE transport (protocol version 2024-11-05). This example only used for testing backwards compatibility for clients.

- Two separate endpoints: `/mcp` for the SSE stream (GET) and `/messages` for client messages (POST)
- Tool implementation with a `start-notification-stream` tool that demonstrates sending periodic notifications

```bash
npx tsx src/examples/server/simpleSseServer.ts
```

#### Streamable Http Backwards Compatible Server with SSE

A server that supports both Streamable HTTP and SSE transports, adhering to the [MCP specification for backwards compatibility](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#backwards-compatibility).

- Single MCP server instance with multiple transport options
- Support for Streamable HTTP requests at `/mcp` endpoint (GET/POST/DELETE)
- Support for deprecated SSE transport with `/sse` (GET) and `/messages` (POST)
- Session type tracking to avoid mixing transport types
- Notifications and tool execution across both transport types

```bash
npx tsx src/examples/server/sseAndStreamableHttpCompatibleServer.ts
```

### Multi-Node Deployment

When deploying MCP servers in a horizontally scaled environment (multiple server instances), there are a few different options that can be useful for different use cases:

- **Stateless mode** - No need to maintain state between calls to MCP servers. Useful for simple API wrapper servers.
- **Persistent storage mode** - No local state needed, but session data is stored in a database. Example: an MCP server for online ordering where the shopping cart is stored in a database.
- **Local state with message routing** - Local state is needed, and all requests for a session must be routed to the correct node. This can be done with a message queue and pub/sub system.

#### Stateless Mode

The Streamable HTTP transport can be configured to operate without tracking sessions. This is perfect for simple API proxies or when each request is completely independent.

##### Implementation

To enable stateless mode, configure the `StreamableHTTPServerTransport` with:

```typescript
sessionIdGenerator: undefined;
```

This disables session management entirely, and the server won't generate or expect session IDs.

- No session ID headers are sent or expected
- Any server node can process any request
- No state is preserved between requests
- Perfect for RESTful or stateless API scenarios
- Simplest deployment model with minimal infrastructure requirements

```
┌─────────────────────────────────────────────┐
│                  Client                     │
└─────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│                Load Balancer                │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│  MCP Server #1  │     │    MCP Server #2    │
│ (Node.js)       │     │  (Node.js)          │
└─────────────────┘     └─────────────────────┘
```

#### Persistent Storage Mode

For cases where you need session continuity but don't need to maintain in-memory state on specific nodes, you can use a database to persist session data while still allowing any node to handle requests.

##### Implementation

Configure the transport with session management, but retrieve and store all state in an external persistent storage:

```typescript
sessionIdGenerator: () => randomUUID(),
eventStore: databaseEventStore
```

All session state is stored in the database, and any node can serve any client by retrieving the state when needed.

- Maintains sessions with unique IDs
- Stores all session data in an external database
- Provides resumability through the database-backed EventStore
- Any node can handle any request for the same session
- No node-specific memory state means no need for message routing
- Good for applications where state can be fully externalized
- Somewhat higher latency due to database access for each request

```
┌─────────────────────────────────────────────┐
│                  Client                     │
└─────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│                Load Balancer                │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│  MCP Server #1  │     │    MCP Server #2    │
│ (Node.js)       │     │  (Node.js)          │
└─────────────────┘     └─────────────────────┘
          │                       │
          │                       │
          ▼                       ▼
┌─────────────────────────────────────────────┐
│           Database (PostgreSQL)             │
│                                             │
│  • Session state                            │
│  • Event storage for resumability           │
└─────────────────────────────────────────────┘
```

#### Streamable HTTP with Distributed Message Routing

For scenarios where local in-memory state must be maintained on specific nodes (such as Computer Use or complex session state), the Streamable HTTP transport can be combined with a pub/sub system to route messages to the correct node handling each session.

1. **Bidirectional Message Queue Integration**:
    - All nodes both publish to and subscribe from the message queue
    - Each node registers the sessions it's actively handling
    - Messages are routed based on session ownership

2. **Request Handling Flow**:
    - When a client connects to Node A with an existing `mcp-session-id`
    - If Node A doesn't own this session, it:
        - Establishes and maintains the SSE connection with the client
        - Publishes the request to the message queue with the session ID
        - Node B (which owns the session) receives the request from the queue
        - Node B processes the request with its local session state
        - Node B publishes responses/notifications back to the queue
        - Node A subscribes to the response channel and forwards to the client

3. **Channel Identification**:
    - Each message channel combines both `mcp-session-id` and `stream-id`
    - This ensures responses are correctly routed back to the originating connection

```
┌─────────────────────────────────────────────┐
│                  Client                     │
└─────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│                Load Balancer                │
└─────────────────────────────────────────────┘
          │                       │
          ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│  MCP Server #1  │◄───►│    MCP Server #2    │
│ (Has Session A) │     │  (Has Session B)    │
└─────────────────┘     └─────────────────────┘
          ▲│                     ▲│
          │▼                     │▼
┌─────────────────────────────────────────────┐
│         Message Queue / Pub-Sub             │
│                                             │
│  • Session ownership registry               │
│  • Bidirectional message routing            │
│  • Request/response forwarding              │
└─────────────────────────────────────────────┘
```

- Maintains session affinity for stateful operations without client redirection
- Enables horizontal scaling while preserving complex in-memory state
- Provides fault tolerance through the message queue as intermediary

## Backwards Compatibility

### Testing Streamable HTTP Backwards Compatibility with SSE

To test the backwards compatibility features:

1. Start one of the server implementations:

    ```bash
    # Legacy SSE server (protocol version 2024-11-05)
    npx tsx src/examples/server/simpleSseServer.ts

    # Streamable HTTP server (protocol version 2025-03-26)
    npx tsx src/examples/server/simpleStreamableHttp.ts

    # Backwards compatible server (supports both protocols)
    npx tsx src/examples/server/sseAndStreamableHttpCompatibleServer.ts
    ```

2. Then run the backwards compatible client:
    ```bash
    npx tsx src/examples/client/streamableHttpWithSseFallbackClient.ts
    ```

This demonstrates how the MCP ecosystem ensures interoperability between clients and servers regardless of which protocol version they were built for.
