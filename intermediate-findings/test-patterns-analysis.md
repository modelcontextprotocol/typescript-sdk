# MCP TypeScript SDK Test Patterns for Sampling

## Overview

This document analyzes test patterns in the MCP TypeScript SDK codebase to understand how to write tests for servers that use sampling (LLM requests). Based on analysis of existing test files and examples.

## Key Testing Components

### 1. Transport Types for Testing

#### InMemoryTransport (Recommended for Unit Tests)
- **Location**: `/src/inMemory.ts`
- **Use case**: Testing client-server interactions within the same process
- **Advantages**:
  - Synchronous, fast execution
  - No external process spawning
  - Full control over both sides of the connection
  - Easy to mock and test error conditions

```typescript
import { InMemoryTransport } from "../inMemory.js";
import { Client } from "../client/index.js";
import { Server } from "../server/index.js";

// Create linked pair - one for client, one for server
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

// Connect both sides
await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);
```

#### StdioClientTransport (For Integration Tests)
- **Location**: `/src/client/stdio.ts`
- **Use case**: Testing real server processes via stdio
- **Pattern**: Spawn actual server process and communicate via stdin/stdout

```typescript
import { StdioClientTransport } from "./stdio.js";

const transport = new StdioClientTransport({
  command: "/path/to/server",
  args: ["arg1", "arg2"],
  env: { CUSTOM_VAR: "value" }
});

await transport.start();
// Use with Client instance
```

### 2. Setting Up Sampling Request Handlers

#### On the Client Side (Simulating LLM)

The client needs to implement a handler for `sampling/createMessage` requests to simulate LLM responses:

```typescript
import { Client } from "../client/index.js";
import { CreateMessageRequestSchema } from "../types.js";

const client = new Client(
  {
    name: "test client",
    version: "1.0",
  },
  {
    capabilities: {
      sampling: {},  // MUST declare sampling capability
    },
  }
);

// Set up handler for sampling requests from server
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  return {
    model: "test-model",
    role: "assistant",
    content: {
      type: "text",
      text: "This is a mock LLM response",
    },
  };
});
```

#### Pattern from `src/server/index.test.ts` (lines 237-248):

```typescript
// Server declares it will call sampling
const server = new Server(
  {
    name: "test server",
    version: "1.0",
  },
  {
    capabilities: {
      prompts: {},
      resources: {},
      tools: {},
      logging: {},
    },
    enforceStrictCapabilities: true,
  },
);

// Client provides sampling capability
const client = new Client(
  {
    name: "test client",
    version: "1.0",
  },
  {
    capabilities: {
      sampling: {},
    },
  },
);

// Implement request handler for sampling/createMessage
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  // Mock implementation of createMessage
  return {
    model: "test-model",
    role: "assistant",
    content: {
      type: "text",
      text: "This is a test response",
    },
  };
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);

// Now server can call createMessage
const response = await server.createMessage({
  messages: [],
  maxTokens: 10,
});
```

### 3. Tool Loop Testing Pattern

Based on `toolLoopSampling.ts` example, here's how to test a server that uses sampling with tools:

```typescript
import { McpServer } from "../server/mcp.js";
import { Client } from "../client/index.js";
import { InMemoryTransport } from "../inMemory.js";
import { CreateMessageRequestSchema, ToolCallContent } from "../types.js";

describe("Server with sampling tool loop", () => {
  test("should handle tool loop with local tools", async () => {
    const mcpServer = new McpServer({
      name: "tool-loop-server",
      version: "1.0.0",
    });

    // Register a tool that uses sampling
    mcpServer.registerTool(
      "fileSearch",
      {
        description: "Search files using AI",
        inputSchema: {
          query: z.string(),
        },
      },
      async ({ query }) => {
        // Tool implementation calls createMessage
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
          tools: [
            {
              name: "ripgrep",
              description: "Search files",
              inputSchema: {
                type: "object",
                properties: {
                  pattern: { type: "string" },
                },
                required: ["pattern"],
              },
            },
          ],
          tool_choice: { mode: "auto" },
        });

        return {
          content: [
            {
              type: "text",
              text: response.content.type === "text"
                ? response.content.text
                : "Tool result",
            },
          ],
        };
      }
    );

    // Set up client that simulates LLM with tool calling
    const client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {
          sampling: {},
        },
      }
    );

    let callCount = 0;
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      callCount++;

      // First call: LLM decides to use tool
      if (callCount === 1) {
        return {
          model: "test-model",
          role: "assistant",
          stopReason: "toolUse",
          content: {
            type: "tool_use",
            id: "tool-call-1",
            name: "ripgrep",
            input: { pattern: "test" },
          } as ToolCallContent,
        };
      }

      // Second call: LLM provides final answer after tool result
      return {
        model: "test-model",
        role: "assistant",
        stopReason: "endTurn",
        content: {
          type: "text",
          text: "Found 5 matches in the files",
        },
      };
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // Test the tool
    const result = await client.callTool({
      name: "fileSearch",
      arguments: { query: "Find TypeScript files" },
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("matches"),
    });
    expect(callCount).toBe(2); // Tool loop made 2 LLM calls
  });
});
```

### 4. Simulating Multi-Turn Conversations

To test a tool loop or conversation:

```typescript
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  const messages = request.params.messages;
  const lastMessage = messages[messages.length - 1];

  // Check if this is a tool result
  if (lastMessage.role === "user" && lastMessage.content.type === "tool_result") {
    // LLM processes tool result and provides final answer
    return {
      model: "test-model",
      role: "assistant",
      stopReason: "endTurn",
      content: {
        type: "text",
        text: "Based on the tool result, here's my answer...",
      },
    };
  }

  // Initial request - ask to use a tool
  return {
    model: "test-model",
    role: "assistant",
    stopReason: "toolUse",
    content: {
      type: "tool_use",
      id: `tool-call-${Date.now()}`,
      name: "some_tool",
      input: { arg: "value" },
    } as ToolCallContent,
  };
});
```

### 5. Test Structure and Cleanup Patterns

#### Basic Test Structure

```typescript
describe("Server with sampling", () => {
  let server: Server;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    server = new Server(
      { name: "test-server", version: "1.0" },
      { capabilities: {} }
    );

    client = new Client(
      { name: "test-client", version: "1.0" },
      { capabilities: { sampling: {} } }
    );

    // Set up sampling handler
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      return {
        model: "test-model",
        role: "assistant",
        content: { type: "text", text: "Mock response" },
      };
    });

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      clientTransport.close(),
      serverTransport.close(),
    ]);
  });

  test("should make sampling request", async () => {
    const result = await server.createMessage({
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Hello" },
        },
      ],
      maxTokens: 100,
    });

    expect(result.content.type).toBe("text");
    expect(result.role).toBe("assistant");
  });
});
```

#### Cleanup Pattern

From `process-cleanup.test.ts`:

```typescript
test("should exit cleanly after closing transport", async () => {
  const server = new Server(
    { name: "test-server", version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Close the transport
  await transport.close();

  // Test passes if we reach here without hanging
  expect(true).toBe(true);
});
```

## 6. Testing with StdioClientTransport

For integration tests that spawn real server processes:

```typescript
import { StdioClientTransport } from "../client/stdio.js";
import { Client } from "../client/index.js";

describe("Integration test with real server", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeEach(() => {
    client = new Client(
      { name: "test-client", version: "1.0" },
      { capabilities: { sampling: {} } }
    );

    // Set up handler for sampling requests from server
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      // Simulate LLM response
      return {
        model: "claude-3-sonnet",
        role: "assistant",
        content: {
          type: "text",
          text: "Mock LLM response for integration test",
        },
      };
    });

    transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "tsx", "path/to/your/server.ts"],
    });
  });

  afterEach(async () => {
    await transport.close();
  });

  test("should communicate with real server", async () => {
    await client.connect(transport);

    // Test server capabilities
    const serverCapabilities = client.getServerCapabilities();
    expect(serverCapabilities).toBeDefined();

    // Call a tool that uses sampling
    const result = await client.callTool({
      name: "ai-powered-tool",
      arguments: { query: "test query" },
    });

    expect(result.content).toBeDefined();
  });
});
```

## 7. Key Patterns from Existing Tests

### Pattern 1: Parallel Connection Setup
```typescript
// Always connect client and server in parallel
await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);
```

### Pattern 2: Capability Declaration
```typescript
// Client MUST declare sampling capability to handle requests
const client = new Client(
  { name: "test-client", version: "1.0" },
  { capabilities: { sampling: {} } }  // Required!
);

// Server checks client capabilities before making sampling requests
expect(server.getClientCapabilities()).toEqual({ sampling: {} });
```

### Pattern 3: Request Handler Registration
```typescript
// Register handler BEFORE connecting
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  // Handler implementation
});

// Then connect
await client.connect(transport);
```

### Pattern 4: Error Handling in Tests
```typescript
test("should throw when capability missing", async () => {
  const clientWithoutSampling = new Client(
    { name: "no-sampling", version: "1.0" },
    { capabilities: {} }  // No sampling!
  );

  await clientWithoutSampling.connect(clientTransport);

  // Server should reject sampling request
  await expect(
    server.createMessage({ messages: [], maxTokens: 10 })
  ).rejects.toThrow(/Client does not support/);
});
```

## 8. Testing Tool Loops - Complete Example

```typescript
describe("Tool loop with sampling", () => {
  test("should execute multi-turn tool loop", async () => {
    const mcpServer = new McpServer({
      name: "tool-loop-test",
      version: "1.0.0",
    });

    // Track tool executions
    const toolExecutions: Array<{ name: string; input: any }> = [];

    // Register local tools that the LLM can call
    const localTools = [
      {
        name: "search",
        description: "Search for information",
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string" as const },
          },
          required: ["query"],
        },
      },
      {
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: { type: "string" as const },
          },
          required: ["path"],
        },
      },
    ];

    // Register a server tool that uses the tool loop
    mcpServer.registerTool(
      "ai_assistant",
      {
        description: "AI assistant with tool access",
        inputSchema: { task: z.string() },
      },
      async ({ task }) => {
        const messages: SamplingMessage[] = [
          {
            role: "user",
            content: { type: "text", text: task },
          },
        ];

        let iteration = 0;
        const MAX_ITERATIONS = 5;

        while (iteration < MAX_ITERATIONS) {
          iteration++;

          const response = await mcpServer.server.createMessage({
            messages,
            maxTokens: 1000,
            tools: localTools,
            tool_choice: { mode: "auto" },
          });

          messages.push({
            role: "assistant",
            content: response.content,
          });

          if (response.stopReason === "toolUse") {
            const toolCall = response.content as ToolCallContent;

            toolExecutions.push({
              name: toolCall.name,
              input: toolCall.input,
            });

            // Simulate tool execution
            const toolResult = {
              result: `Mock result for ${toolCall.name}`,
            };

            messages.push({
              role: "user",
              content: {
                type: "tool_result",
                toolUseId: toolCall.id,
                content: toolResult,
              },
            });

            continue;
          }

          // Final answer
          if (response.content.type === "text") {
            return {
              content: [{ type: "text", text: response.content.text }],
            };
          }
        }

        throw new Error("Max iterations exceeded");
      }
    );

    // Set up client to simulate LLM
    const client = new Client(
      { name: "test-client", version: "1.0" },
      { capabilities: { sampling: {} } }
    );

    let samplingCallCount = 0;
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      samplingCallCount++;
      const messages = request.params.messages;
      const lastMessage = messages[messages.length - 1];

      // First call: use search tool
      if (samplingCallCount === 1) {
        return {
          model: "test-model",
          role: "assistant",
          stopReason: "toolUse",
          content: {
            type: "tool_use",
            id: "call-1",
            name: "search",
            input: { query: "typescript files" },
          },
        };
      }

      // Second call: use read tool
      if (samplingCallCount === 2) {
        return {
          model: "test-model",
          role: "assistant",
          stopReason: "toolUse",
          content: {
            type: "tool_use",
            id: "call-2",
            name: "read",
            input: { path: "file.ts" },
          },
        };
      }

      // Third call: provide final answer
      return {
        model: "test-model",
        role: "assistant",
        stopReason: "endTurn",
        content: {
          type: "text",
          text: "Found and analyzed the files",
        },
      };
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // Execute the tool
    const result = await client.callTool({
      name: "ai_assistant",
      arguments: { task: "Find TypeScript files" },
    });

    // Verify
    expect(samplingCallCount).toBe(3);
    expect(toolExecutions).toHaveLength(2);
    expect(toolExecutions[0].name).toBe("search");
    expect(toolExecutions[1].name).toBe("read");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Found"),
    });
  });
});
```

## 9. Common Pitfalls and Solutions

### Pitfall 1: Not Declaring Capabilities
```typescript
// ❌ WRONG - will throw error
const client = new Client({ name: "test", version: "1.0" });
client.setRequestHandler(CreateMessageRequestSchema, ...);  // Throws!

// ✅ CORRECT
const client = new Client(
  { name: "test", version: "1.0" },
  { capabilities: { sampling: {} } }  // Declare first!
);
client.setRequestHandler(CreateMessageRequestSchema, ...);
```

### Pitfall 2: Registering Handler After Connect
```typescript
// ❌ WRONG - handler not available during initialization
await client.connect(transport);
client.setRequestHandler(CreateMessageRequestSchema, ...);  // Too late!

// ✅ CORRECT
client.setRequestHandler(CreateMessageRequestSchema, ...);
await client.connect(transport);
```

### Pitfall 3: Not Handling Tool Loop Properly
```typescript
// ❌ WRONG - doesn't handle tool results
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  // Always returns tool use, causing infinite loop
  return {
    model: "test",
    role: "assistant",
    stopReason: "toolUse",
    content: { type: "tool_use", ... },
  };
});

// ✅ CORRECT - check message history
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  const messages = request.params.messages;
  const lastMessage = messages[messages.length - 1];

  if (lastMessage.content.type === "tool_result") {
    // Provide final answer after tool use
    return {
      model: "test",
      role: "assistant",
      stopReason: "endTurn",
      content: { type: "text", text: "Final answer" },
    };
  }

  // Initial request - use tool
  return { ... };
});
```

## 10. File Locations Reference

Key files for understanding test patterns:

- **Client Tests**: `/src/client/index.test.ts` (lines 583-636 for sampling handler examples)
- **Server Tests**: `/src/server/index.test.ts` (lines 208-270, 728-864 for sampling tests)
- **InMemory Transport**: `/src/inMemory.ts`
- **Stdio Transport Tests**:
  - `/src/client/stdio.test.ts`
  - `/src/client/cross-spawn.test.ts`
- **Tool Loop Example**: `/src/examples/server/toolLoopSampling.ts`
- **Backfill Proxy Example**: `/src/examples/backfill/backfillSampling.ts`
- **McpServer Tests**: `/src/server/mcp.test.ts`

## Summary

**For unit tests of servers with sampling:**
1. Use `InMemoryTransport.createLinkedPair()`
2. Create `Client` with `capabilities: { sampling: {} }`
3. Register `CreateMessageRequestSchema` handler on client before connecting
4. Connect both client and server in parallel
5. Simulate LLM responses in the handler
6. For tool loops, track message history and alternate between tool use and final answer

**For integration tests:**
1. Use `StdioClientTransport` to spawn real server process
2. Still need to provide sampling handler on client side
3. Test actual server behavior with realistic scenarios
4. Ensure proper cleanup of spawned processes
