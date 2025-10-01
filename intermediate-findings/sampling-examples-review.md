# MCP TypeScript SDK - Sampling Examples Review

## Overview

This document provides a comprehensive review of sampling examples in the MCP TypeScript SDK, covering their structure, patterns, dependencies, and best practices for implementation.

---

## Key Sampling Examples

### 1. **backfillSampling.ts** (Proxy Pattern)
**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/backfill/backfillSampling.ts`

**Purpose:** Implements an MCP proxy that backfills sampling requests using the Claude API when a client doesn't support native sampling.

**Key Features:**
- Acts as a middleware proxy between client and server
- Detects client sampling capabilities during initialization
- Intercepts `sampling/createMessage` requests
- Translates MCP requests to Claude API format
- Handles tool calling support
- Converts responses back to MCP format

**Dependencies:**
```typescript
import { Anthropic } from "@anthropic-ai/sdk";
import { StdioServerTransport } from '../../server/stdio.js';
import { StdioClientTransport } from '../../client/stdio.js';
```

**Usage Pattern:**
```bash
npx -y @modelcontextprotocol/inspector \
  npx -y --silent tsx src/examples/backfill/backfillSampling.ts \
    npx -y --silent @modelcontextprotocol/server-everything
```

---

### 2. **toolWithSampleServer.ts** (Server-Side Sampling)
**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/toolWithSampleServer.ts`

**Purpose:** Demonstrates how a server can use LLM sampling to implement intelligent tools.

**Key Features:**
- Registers tools that internally use sampling
- Simple `summarize` tool that uses `mcpServer.server.createMessage()`
- Shows how to call LLM through MCP sampling API
- Demonstrates proper response handling

**Core Pattern:**
```typescript
mcpServer.registerTool(
  "summarize",
  {
    description: "Summarize any text using an LLM",
    inputSchema: {
      text: z.string().describe("Text to summarize"),
    },
  },
  async ({ text }) => {
    // Call the LLM through MCP sampling
    const response = await mcpServer.server.createMessage({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please summarize the following text concisely:\n\n${text}`,
          },
        },
      ],
      maxTokens: 500,
    });

    return {
      content: [
        {
          type: "text",
          text: response.content.type === "text" ? response.content.text : "Unable to generate summary",
        },
      ],
    };
  }
);
```

**Transport Setup:**
```typescript
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
```

---

## Common Server Example Patterns

### 3. **simpleStreamableHttp.ts** (Full-Featured Server)
**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/simpleStreamableHttp.ts`

**Key Patterns:**
- Express-based HTTP server setup
- Session management with in-memory event store
- Tool registration with `registerTool()` or `tool()`
- Prompt registration with `registerPrompt()`
- Resource registration with `registerResource()`
- Notification handling via `sendLoggingMessage()`
- OAuth support (optional)

**Server Initialization:**
```typescript
const getServer = () => {
  const server = new McpServer({
    name: 'simple-streamable-http-server',
    version: '1.0.0',
    icons: [{src: './mcp.svg', sizes: ['512x512'], mimeType: 'image/svg+xml'}],
    websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk',
  }, { capabilities: { logging: {} } });

  // Register tools, prompts, resources...
  return server;
};
```

**Transport Management:**
```typescript
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// For new sessions
const eventStore = new InMemoryEventStore();
transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore, // Enable resumability
  onsessioninitialized: (sessionId) => {
    console.log(`Session initialized with ID: ${sessionId}`);
    transports[sessionId] = transport;
  }
});

// Connect and handle requests
const server = getServer();
await server.connect(transport);
await transport.handleRequest(req, res, req.body);
```

---

### 4. **simpleSseServer.ts** (SSE Transport Pattern)
**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/simpleSseServer.ts`

**Key Patterns:**
- Deprecated HTTP+SSE transport (protocol version 2024-11-05)
- Separate endpoints for SSE stream and messages
- Session tracking by transport

**Transport Setup:**
```typescript
const transports: Record<string, SSEServerTransport> = {};

app.get('/mcp', async (req: Request, res: Response) => {
  const transport = new SSEServerTransport('/messages', res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;

  transport.onclose = () => {
    delete transports[sessionId];
  };

  const server = getServer();
  await server.connect(transport);
});

app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  await transport.handlePostMessage(req, res, req.body);
});
```

---

## Client Example Patterns

### 5. **parallelToolCallsClient.ts**
**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/client/parallelToolCallsClient.ts`

**Key Patterns:**
- Client initialization with capabilities
- Transport connection
- Notification handlers
- Parallel tool execution
- Request handling with schemas

**Client Setup:**
```typescript
const client = new Client({
  name: 'parallel-tool-calls-client',
  version: '1.0.0'
});

client.onerror = (error) => {
  console.error('Client error:', error);
};

const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
await client.connect(transport);

// Set up notification handlers
client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
  console.log(`Notification: ${notification.params.data}`);
});
```

**Tool Calling:**
```typescript
const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'tool-name',
    arguments: { /* args */ }
  }
}, CallToolResultSchema);
```

---

## Type System Structure

### Sampling Types (from types.ts)

**CreateMessageRequest:**
```typescript
export const CreateMessageRequestSchema = RequestSchema.extend({
  method: z.literal("sampling/createMessage"),
  params: BaseRequestParamsSchema.extend({
    messages: z.array(SamplingMessageSchema),
    systemPrompt: z.optional(z.string()),
    includeContext: z.optional(z.enum(["none", "thisServer", "allServers"])),
    temperature: z.optional(z.number()),
    maxTokens: z.number().int(),
    stopSequences: z.optional(z.array(z.string())),
    metadata: z.optional(z.object({}).passthrough()),
    modelPreferences: z.optional(ModelPreferencesSchema),
    tools: z.optional(z.array(ToolSchema)), // Tool definitions
    tool_choice: z.optional(ToolChoiceSchema), // Tool usage control
  }),
});
```

**CreateMessageResult:**
```typescript
export const CreateMessageResultSchema = ResultSchema.extend({
  model: z.string(),
  stopReason: z.optional(
    z.enum(["endTurn", "stopSequence", "maxTokens", "toolUse", "refusal", "other"]).or(z.string()),
  ),
  role: z.literal("assistant"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,
  ]),
});
```

**Message Types:**
```typescript
// User message (from server to LLM)
export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolResultContentSchema,
  ]),
  _meta: z.optional(z.object({}).passthrough()),
});

// Assistant message (from LLM to server)
export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,
  ]),
  _meta: z.optional(z.object({}).passthrough()),
});
```

---

## Server Class Methods (from server/index.ts)

### Sampling Methods

**createMessage:**
```typescript
async createMessage(
  params: CreateMessageRequest["params"],
  options?: RequestOptions,
) {
  return this.request(
    { method: "sampling/createMessage", params },
    CreateMessageResultSchema,
    options,
  );
}
```

**elicitInput:**
```typescript
async elicitInput(
  params: ElicitRequest["params"],
  options?: RequestOptions,
): Promise<ElicitResult> {
  const result = await this.request(
    { method: "elicitation/create", params },
    ElicitResultSchema,
    options,
  );
  // Validates response content against requested schema
  return result;
}
```

### Capability Assertions

The Server class validates capabilities before allowing methods:

```typescript
protected assertCapabilityForMethod(method: RequestT["method"]): void {
  switch (method as ServerRequest["method"]) {
    case "sampling/createMessage":
      if (!this._clientCapabilities?.sampling) {
        throw new Error(
          `Client does not support sampling (required for ${method})`,
        );
      }
      break;

    case "elicitation/create":
      if (!this._clientCapabilities?.elicitation) {
        throw new Error(
          `Client does not support elicitation (required for ${method})`,
        );
      }
      break;
  }
}
```

---

## Dependencies

### Core Dependencies
- **zod**: Schema validation (v3.23.8)
- **express**: HTTP server framework (v5.0.1)
- **cors**: CORS middleware (v2.8.5)

### Sampling-Specific Dependencies
- **@anthropic-ai/sdk**: Claude API client (v0.65.0) - devDependency
  - Used in backfillSampling.ts example
  - Provides types and API client for Claude integration

### Transport Dependencies
- **eventsource**: SSE client support (v3.0.2)
- **eventsource-parser**: SSE parsing (v3.0.0)
- **cross-spawn**: Process spawning for stdio (v7.0.5)

### Other Utilities
- **ajv**: JSON Schema validation (v6.12.6)
- **zod-to-json-schema**: Convert Zod to JSON Schema (v3.24.1)

---

## Tool Registration Patterns

### Pattern 1: registerTool (with metadata)
```typescript
mcpServer.registerTool(
  'tool-name',
  {
    title: 'Tool Display Name',
    description: 'Tool description',
    inputSchema: {
      param1: z.string().describe('Parameter description'),
      param2: z.number().optional().describe('Optional parameter'),
    },
  },
  async (args): Promise<CallToolResult> => {
    // Tool implementation
    return {
      content: [
        {
          type: 'text',
          text: 'Result text',
        },
      ],
    };
  }
);
```

### Pattern 2: tool (shorthand)
```typescript
mcpServer.tool(
  'tool-name',
  'Tool description',
  {
    param1: z.string().describe('Parameter description'),
  },
  {
    title: 'Tool Display Name',
    readOnlyHint: true,
    openWorldHint: false
  },
  async (args, extra): Promise<CallToolResult> => {
    // Access session ID via extra.sessionId
    return {
      content: [{ type: 'text', text: 'Result' }],
    };
  }
);
```

---

## Notification Patterns

### Sending Notifications from Server
```typescript
// In tool handler
async ({ name }, extra): Promise<CallToolResult> => {
  // Send logging notification
  await server.sendLoggingMessage({
    level: "info",
    data: `Processing request for ${name}`
  }, extra.sessionId);

  // Process...

  return {
    content: [{ type: 'text', text: 'Done' }],
  };
}
```

### Receiving Notifications in Client
```typescript
client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
  console.log(`[${notification.params.level}] ${notification.params.data}`);
});
```

---

## Error Handling Patterns

### Server-Side Error Handling
```typescript
try {
  const result = await someOperation();
  return {
    content: [{ type: 'text', text: result }],
  };
} catch (error) {
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      },
    ],
  };
}
```

### Client-Side Error Handling
```typescript
client.onerror = (error) => {
  console.error('Client error:', error);
};

try {
  const result = await client.request(request, schema);
} catch (error) {
  console.error('Request failed:', error);
}
```

---

## Best Practices

### 1. **Server Setup**
- Use `getServer()` pattern to create fresh server instances
- Register capabilities at initialization: `{ capabilities: { logging: {}, sampling: {} } }`
- Set up proper session management with unique IDs
- Implement proper cleanup in `onclose` handlers

### 2. **Tool Implementation**
- Use Zod schemas for input validation
- Provide clear descriptions for all parameters
- Return proper `CallToolResult` format
- Handle errors gracefully and return user-friendly messages
- Use `extra.sessionId` when sending notifications

### 3. **Sampling Integration**
- Check client capabilities before calling `createMessage()`
- Provide clear system prompts
- Set appropriate `maxTokens` limits
- Handle all possible `stopReason` values
- Check response `content.type` before accessing type-specific fields

### 4. **Transport Management**
- Store transports by session ID in a map
- Clean up closed transports
- Support resumability with EventStore
- Handle reconnection scenarios

### 5. **Type Safety**
- Use Zod schemas for request/response validation
- Use type guards for message discrimination
- Validate schemas with `.safeParse()` when needed
- Export and reuse schema definitions

### 6. **Error Handling**
- Set up `onerror` handlers
- Validate capabilities before making requests
- Handle transport errors gracefully
- Provide meaningful error messages

---

## File Structure Convention

```
src/examples/
├── client/              # Client implementations
│   ├── simpleStreamableHttp.ts
│   ├── parallelToolCallsClient.ts
│   └── ...
├── server/              # Server implementations
│   ├── simpleStreamableHttp.ts
│   ├── simpleSseServer.ts
│   ├── toolWithSampleServer.ts
│   └── ...
├── backfill/           # Proxy/middleware implementations
│   └── backfillSampling.ts
└── shared/             # Shared utilities
    └── inMemoryEventStore.ts
```

---

## Testing Patterns

### Running Examples

**Server:**
```bash
npx tsx src/examples/server/simpleStreamableHttp.ts
npx tsx src/examples/server/toolWithSampleServer.ts
```

**Client:**
```bash
npx tsx src/examples/client/simpleStreamableHttp.ts
```

**Proxy:**
```bash
npx -y @modelcontextprotocol/inspector \
  npx -y --silent tsx src/examples/backfill/backfillSampling.ts \
    npx -y --silent @modelcontextprotocol/server-everything
```

### Test Suite Pattern
- Co-locate tests with source: `*.test.ts`
- Use descriptive test names
- Test both success and error cases
- Validate schemas with Zod
- Mock transports for unit tests

---

## Code Style

- **TypeScript**: Strict mode, explicit return types
- **Naming**: PascalCase for classes/types, camelCase for functions/variables
- **Files**: Lowercase with hyphens, test files with `.test.ts` suffix
- **Imports**: ES module style, include `.js` extension
- **Formatting**: 2-space indentation, semicolons required, single quotes preferred
- **Comments**: JSDoc for public APIs

---

## Adaptable Code Snippets

### Basic Server Setup
```typescript
import { McpServer } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { z } from "zod";

const mcpServer = new McpServer({
  name: "my-server",
  version: "1.0.0",
}, { capabilities: { sampling: {} } });

mcpServer.registerTool(
  "my-tool",
  {
    description: "My tool description",
    inputSchema: {
      input: z.string().describe("Input parameter"),
    },
  },
  async ({ input }) => {
    // Tool logic here
    return {
      content: [
        {
          type: "text",
          text: `Processed: ${input}`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.log("Server running...");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
```

### Sampling Tool Pattern
```typescript
mcpServer.registerTool(
  "llm-powered-tool",
  {
    description: "Tool that uses LLM sampling",
    inputSchema: {
      query: z.string().describe("Query to process"),
    },
  },
  async ({ query }) => {
    try {
      const response = await mcpServer.server.createMessage({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: query,
            },
          },
        ],
        maxTokens: 1000,
      });

      return {
        content: [
          {
            type: "text",
            text: response.content.type === "text"
              ? response.content.text
              : "Unable to generate response",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }
);
```

### HTTP Server with Tools
```typescript
import express from 'express';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { InMemoryEventStore } from '../shared/inMemoryEventStore.js';

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

const getServer = () => {
  const server = new McpServer({
    name: 'my-http-server',
    version: '1.0.0',
  }, { capabilities: { logging: {} } });

  // Register tools...

  return server;
};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  let transport: StreamableHTTPServerTransport;
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const eventStore = new InMemoryEventStore();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore,
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      }
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) {
        delete transports[sid];
      }
    };

    const server = getServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```

---

## Summary

The MCP TypeScript SDK provides a robust framework for implementing sampling-enabled MCP servers. Key takeaways:

1. **Two Main Sampling Patterns:**
   - **Proxy/Backfill**: Intercept and handle sampling for non-supporting clients
   - **Server-Side Tools**: Implement tools that use sampling internally

2. **Core Components:**
   - `McpServer` for server implementation
   - `Server.createMessage()` for sampling requests
   - Transport abstractions (Stdio, HTTP, SSE)
   - Zod-based schema validation

3. **Best Practices:**
   - Check capabilities before making sampling requests
   - Provide clear tool descriptions and schemas
   - Handle errors gracefully
   - Clean up resources properly
   - Use TypeScript strict mode

4. **Examples Structure:**
   - Simple examples for learning (toolWithSampleServer.ts)
   - Complex examples for reference (backfillSampling.ts)
   - Full-featured servers (simpleStreamableHttp.ts)
   - Client implementations for testing

This foundation enables building sophisticated MCP servers that leverage LLM capabilities while maintaining proper protocol compliance and type safety.
