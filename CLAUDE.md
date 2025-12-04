# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```sh
npm run build        # Build ESM and CJS versions
npm run lint         # Run ESLint and Prettier check
npm run lint:fix     # Auto-fix lint and formatting issues
npm test             # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npx vitest path/to/file.test.ts  # Run specific test file
npx vitest -t "test name"        # Run tests matching pattern
npm run typecheck    # Type-check without emitting
```

## Code Style Guidelines

- **TypeScript**: Strict type checking, ES modules, explicit return types
- **Naming**: PascalCase for classes/types, camelCase for functions/variables
- **Files**: Lowercase with hyphens, test files with `.test.ts` suffix
- **Imports**: ES module style, include `.js` extension, group imports logically
- **Formatting**: 2-space indentation, semicolons required, single quotes preferred
- **Testing**: Co-locate tests with source files, use descriptive test names
- **Comments**: JSDoc for public APIs, inline comments for complex logic

## Architecture Overview

### Core Layers

The SDK is organized into three main layers:

1. **Types Layer** (`src/types.ts`) - Protocol types generated from the MCP specification. All JSON-RPC message types, schemas, and protocol constants are defined here using Zod v4.

2. **Protocol Layer** (`src/shared/protocol.ts`) - The abstract `Protocol` class that handles JSON-RPC message routing, request/response correlation, capability negotiation, and transport management. Both `Client` and `Server` extend this class.

3. **High-Level APIs**:
    - `Client` (`src/client/index.ts`) - Low-level client extending Protocol with typed methods for all MCP operations
    - `Server` (`src/server/index.ts`) - Low-level server extending Protocol with request handler registration
    - `McpServer` (`src/server/mcp.ts`) - High-level server API with simplified resource/tool/prompt registration

### Transport System

Transports (`src/shared/transport.ts`) provide the communication layer:

- **Streamable HTTP** (`src/server/streamableHttp.ts`, `src/client/streamableHttp.ts`) - Recommended transport for remote servers, supports SSE for streaming
- **SSE** (`src/server/sse.ts`, `src/client/sse.ts`) - Legacy HTTP+SSE transport for backwards compatibility
- **stdio** (`src/server/stdio.ts`, `src/client/stdio.ts`) - For local process-spawned integrations

### Server-Side Features

- **Tools/Resources/Prompts**: Registered via `McpServer.tool()`, `.resource()`, `.prompt()` methods
- **OAuth/Auth**: Full OAuth 2.0 server implementation in `src/server/auth/`
- **Completions**: Auto-completion support via `src/server/completable.ts`

### Client-Side Features

- **Auth**: OAuth client support in `src/client/auth.ts` and `src/client/auth-extensions.ts`
- **Middleware**: Request middleware in `src/client/middleware.ts`
- **Sampling**: Clients can handle `sampling/createMessage` requests from servers (LLM completions)
- **Elicitation**: Clients can handle `elicitation/create` requests for user input (form or URL mode)
- **Roots**: Clients can expose filesystem roots to servers via `roots/list`

### Experimental Features

Located in `src/experimental/`:

- **Tasks**: Long-running task support with polling/resumption (`src/experimental/tasks/`)

### Zod Compatibility

The SDK uses `zod/v4` internally but supports both v3 and v4 APIs. Compatibility utilities:

- `src/server/zod-compat.ts` - Schema parsing helpers that work across versions
- `src/server/zod-json-schema-compat.ts` - Converts Zod schemas to JSON Schema

### Validation

Pluggable JSON Schema validation (`src/validation/`):

- `ajv-provider.ts` - Default Ajv-based validator
- `cfworker-provider.ts` - Cloudflare Workers-compatible alternative

### Examples

Runnable examples in `src/examples/`:

- `server/` - Various server configurations (stateful, stateless, OAuth, etc.)
- `client/` - Client examples (basic, OAuth, parallel calls, etc.)
- `shared/` - Shared utilities like in-memory event store

## Message Flow (Bidirectional Protocol)

MCP is bidirectional: both client and server can send requests. Understanding this flow is essential when implementing new request types.

### Class Hierarchy

```
Protocol (abstract base)
├── Client (src/client/index.ts)     - can send requests TO server, handle requests FROM server
└── Server (src/server/index.ts)     - can send requests TO client, handle requests FROM client
    └── McpServer (src/server/mcp.ts) - high-level wrapper around Server
```

### Outbound Flow: Sending Requests

When code calls `client.callTool()` or `server.createMessage()`:

1. **High-level method** (e.g., `Client.callTool()`) calls `this.request()`
2. **`Protocol.request()`**:
    - Assigns unique message ID
    - Checks capabilities via `assertCapabilityForMethod()` (abstract, implemented by Client/Server)
    - Creates response handler promise
    - Calls `transport.send()` with JSON-RPC request
    - Waits for response handler to resolve
3. **Transport** serializes and sends over wire (HTTP, stdio, etc.)
4. **`Protocol._onresponse()`** resolves the promise when response arrives

### Inbound Flow: Handling Requests

When a request arrives from the remote side:

1. **Transport** receives message, calls `transport.onmessage()`
2. **`Protocol.connect()`** routes to `_onrequest()`, `_onresponse()`, or `_onnotification()`
3. **`Protocol._onrequest()`**:
    - Looks up handler in `_requestHandlers` map (keyed by method name)
    - Creates `RequestHandlerExtra` with `signal`, `sessionId`, `sendNotification`, `sendRequest`
    - Invokes handler, sends JSON-RPC response back via transport
4. **Handler** was registered via `setRequestHandler(Schema, handler)`

### Handler Registration

```typescript
// In Client (for server→client requests like sampling, elicitation)
client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
  // Handle sampling request from server
  return { role: "assistant", content: {...}, model: "..." };
});

// In Server (for client→server requests like tools/call)
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  // Handle tool call from client
  return { content: [...] };
});
```

### Request Handler Extra

The `extra` parameter in handlers (`RequestHandlerExtra`) provides:

- `signal`: AbortSignal for cancellation
- `sessionId`: Transport session identifier
- `authInfo`: Validated auth token info (if authenticated)
- `requestId`: JSON-RPC message ID
- `sendNotification(notification)`: Send related notification back
- `sendRequest(request, schema)`: Send related request (for bidirectional flows)
- `taskStore`: Task storage interface (if tasks enabled)

### Capability Checking

Both sides declare capabilities during initialization. The SDK enforces these:

- **Client→Server**: `Client.assertCapabilityForMethod()` checks `_serverCapabilities`
- **Server→Client**: `Server.assertCapabilityForMethod()` checks `_clientCapabilities`
- **Handler registration**: `assertRequestHandlerCapability()` validates local capabilities

### Adding a New Request Type

1. **Define schema** in `src/types.ts` (request params, result schema)
2. **Add capability** to `ClientCapabilities` or `ServerCapabilities` in types
3. **Implement sender** method in Client or Server class
4. **Add capability check** in the appropriate `assertCapabilityForMethod()`
5. **Register handler** on the receiving side with `setRequestHandler()`
6. **For McpServer**: Add high-level wrapper method if needed

### Server-Initiated Requests (Sampling, Elicitation)

Server can request actions from client (requires client capability):

```typescript
// Server sends sampling request to client
const result = await server.createMessage({
  messages: [...],
  maxTokens: 100
});

// Client must have registered handler:
client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
  // Client-side LLM call
  return { role: "assistant", content: {...} };
});
```

## Key Patterns

### Request Handler Registration (Low-Level Server)

```typescript
server.setRequestHandler(SomeRequestSchema, async (request, extra) => {
    // extra contains sessionId, authInfo, sendNotification, etc.
    return {
        /* result */
    };
});
```

### Tool Registration (High-Level McpServer)

```typescript
mcpServer.tool('tool-name', { param: z.string() }, async ({ param }, extra) => {
    return { content: [{ type: 'text', text: 'result' }] };
});
```

### Transport Connection

```typescript
// Server
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(transport);

// Client
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));
await client.connect(transport);
```
