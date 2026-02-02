# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```sh
pnpm install         # Install all workspace dependencies

pnpm build:all       # Build all packages
pnpm lint:all        # Run ESLint + Prettier checks across all packages
pnpm lint:fix:all    # Auto-fix lint and formatting issues across all packages
pnpm typecheck:all   # Type-check all packages
pnpm test:all        # Run all tests (vitest) across all packages
pnpm check:all       # typecheck + lint across all packages

# Run a single package script (examples)
# Run a single package script from the repo root with pnpm filter
pnpm --filter @modelcontextprotocol/core test                # vitest run (core)
pnpm --filter @modelcontextprotocol/core test:watch          # vitest (watch)
pnpm --filter @modelcontextprotocol/core test -- path/to/file.test.ts
pnpm --filter @modelcontextprotocol/core test -- -t "test name"
```

## Breaking Changes

When making breaking changes, document them in **both**:

- `docs/migration.md` — human-readable guide with before/after code examples
- `docs/migration-SKILL.md` — LLM-optimized mapping tables for mechanical migration

Include what changed, why, and how to migrate. Search for related sections and group
related changes together rather than adding new standalone sections.

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

1. **Types Layer** (`packages/core/src/types/types.ts`) - Protocol types generated from the MCP specification. All JSON-RPC message types, schemas, and protocol constants are defined here using Zod v4.

2. **Protocol Layer** (`packages/core/src/shared/protocol.ts`) - The abstract `Protocol` class that handles JSON-RPC message routing, request/response correlation, capability negotiation, and transport management. Both `Client` and `Server` extend this class.

3. **High-Level APIs**:
    - `Client` (`packages/client/src/client/client.ts`) - Client implementation extending Protocol with typed methods for MCP operations
    - `Server` (`packages/server/src/server/server.ts`) - Server implementation extending Protocol with request handler registration
    - `McpServer` (`packages/server/src/server/mcp.ts`) - High-level server API with simplified resource/tool/prompt registration

### Transport System

Transports (`packages/core/src/shared/transport.ts`) provide the communication layer:

- **Streamable HTTP** (`packages/server/src/server/streamableHttp.ts`, `packages/client/src/client/streamableHttp.ts`) - Recommended transport for remote servers, supports SSE for streaming
- **SSE** (`packages/server/src/server/sse.ts`, `packages/client/src/client/sse.ts`) - Legacy HTTP+SSE transport for backwards compatibility
- **stdio** (`packages/server/src/server/stdio.ts`, `packages/client/src/client/stdio.ts`) - For local process-spawned integrations

### Server-Side Features

- **Tools/Resources/Prompts**: Registered via `McpServer.tool()`, `.resource()`, `.prompt()` methods
- **OAuth/Auth**: Full OAuth 2.0 server implementation in `packages/server/src/server/auth/`
- **Completions**: Auto-completion support via `packages/server/src/server/completable.ts`

### Client-Side Features

- **Auth**: OAuth client support in `packages/client/src/client/auth.ts` and `packages/client/src/client/auth-extensions.ts`
- **Client middleware**: Request middleware in `packages/client/src/client/middleware.ts` (unrelated to the framework adapter packages below)
- **Sampling**: Clients can handle `sampling/createMessage` requests from servers (LLM completions)
- **Elicitation**: Clients can handle `elicitation/create` requests for user input (form or URL mode)
- **Roots**: Clients can expose filesystem roots to servers via `roots/list`

### Middleware packages (framework/runtime adapters)

The repo also ships “middleware” packages under `packages/middleware/` (e.g. `@modelcontextprotocol/express`, `@modelcontextprotocol/hono`, `@modelcontextprotocol/node`). These are thin integration layers for specific frameworks/runtimes and should not add new MCP functionality.

### Experimental Features

Located in `packages/*/src/experimental/`:

- **Tasks**: Long-running task support with polling/resumption (`packages/core/src/experimental/tasks/`)

### Zod Compatibility

The SDK uses `zod/v4` internally but supports both v3 and v4 APIs. Compatibility utilities:

- `packages/core/src/util/zod-compat.ts` - Schema parsing helpers that work across versions
- `packages/core/src/util/zod-json-schema-compat.ts` - Converts Zod schemas to JSON Schema

### Validation

Pluggable JSON Schema validation (`packages/core/src/validation/`):

- `ajv-provider.ts` - Default Ajv-based validator
- `cfworker-provider.ts` - Cloudflare Workers-compatible alternative

### Examples

Runnable examples in `examples/`:

- `examples/server/src/` - Various server configurations (stateful, stateless, OAuth, etc.)
- `examples/client/src/` - Client examples (basic, OAuth, parallel calls, etc.)
- `examples/shared/src/` - Shared utilities (OAuth demo provider, etc.)

## Message Flow (Bidirectional Protocol)

MCP is bidirectional: both client and server can send requests. Understanding this flow is essential when implementing new request types.

### Class Hierarchy

```
Protocol (abstract base)
├── Client (packages/client/src/client/client.ts)     - can send requests TO server, handle requests FROM server
└── Server (packages/server/src/server/server.ts)     - can send requests TO client, handle requests FROM client
    └── McpServer (packages/server/src/server/mcp.ts) - high-level wrapper around Server
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
// (Node.js IncomingMessage/ServerResponse wrapper; exported by @modelcontextprotocol/node)
const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(transport);

// Client
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));
await client.connect(transport);
```
