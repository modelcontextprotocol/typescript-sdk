# Client Sampling API Documentation

## Overview

This document describes how to use the MCP TypeScript SDK Client API to handle `sampling/createMessage` requests. The sampling capability allows MCP servers to request language model completions from clients, enabling servers to use AI capabilities without directly accessing LLM APIs.

## Table of Contents

1. [Setup and Configuration](#setup-and-configuration)
2. [Request Handler Registration](#request-handler-registration)
3. [Handler Signature and Parameters](#handler-signature-and-parameters)
4. [Request Structure](#request-structure)
5. [Response Construction](#response-construction)
6. [Content Types](#content-types)
7. [Tool Calling Support](#tool-calling-support)
8. [Complete Examples](#complete-examples)
9. [Best Practices and Gotchas](#best-practices-and-gotchas)

---

## Setup and Configuration

### 1. Declare Sampling Capability

To handle sampling requests, you must declare the `sampling` capability when creating the client:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const client = new Client(
  {
    name: "my-client",
    version: "1.0.0",
  },
  {
    capabilities: {
      sampling: {},  // Required to handle sampling/createMessage requests
    },
  }
);
```

**Important:** Without declaring the `sampling` capability, calling `setRequestHandler` with `CreateMessageRequestSchema` will throw an error:
```
Error: Client does not support sampling capability (required for sampling/createMessage)
```

---

## Request Handler Registration

### Method: `client.setRequestHandler()`

The `setRequestHandler` method is used to register a handler for incoming `sampling/createMessage` requests.

```typescript
import { CreateMessageRequestSchema, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

client.setRequestHandler(
  CreateMessageRequestSchema,
  async (request, extra) => {
    // Handler implementation
    return result; // CreateMessageResult
  }
);
```

### Parameters

1. **Schema**: `CreateMessageRequestSchema` - Zod schema defining the request structure
2. **Handler**: Async function with signature:
   ```typescript
   (request: CreateMessageRequest, extra: RequestHandlerExtra) => Promise<CreateMessageResult> | CreateMessageResult
   ```

---

## Handler Signature and Parameters

### Handler Function Signature

```typescript
async function handler(
  request: CreateMessageRequest,
  extra: RequestHandlerExtra<SendRequestT, SendNotificationT>
): Promise<CreateMessageResult>
```

### Request Parameter (`CreateMessageRequest`)

The request object contains:

```typescript
interface CreateMessageRequest {
  method: "sampling/createMessage";
  params: {
    // Required: Array of conversation messages
    messages: SamplingMessage[];

    // Required: Maximum tokens to generate
    maxTokens: number;

    // Optional: System prompt for the LLM
    systemPrompt?: string;

    // Optional: Temperature parameter (0-1)
    temperature?: number;

    // Optional: Stop sequences
    stopSequences?: string[];

    // Optional: Tools available to the LLM
    tools?: Tool[];

    // Optional: Tool choice configuration
    tool_choice?: ToolChoice;

    // Optional: Model preferences/hints
    modelPreferences?: ModelPreferences;

    // Optional: Metadata
    metadata?: Record<string, unknown>;

    // DEPRECATED: Context inclusion preference
    includeContext?: "none" | "thisServer" | "allServers";

    // Internal metadata
    _meta?: Record<string, unknown>;
  };
}
```

### Extra Parameter (`RequestHandlerExtra`)

The `extra` object provides additional context and utilities:

```typescript
interface RequestHandlerExtra<SendRequestT, SendNotificationT> {
  // Abort signal for cancellation
  signal: AbortSignal;

  // JSON-RPC request ID
  requestId: RequestId;

  // Session ID from transport (if available)
  sessionId?: string;

  // Authentication info (if available)
  authInfo?: AuthInfo;

  // Request metadata
  _meta?: RequestMeta;

  // Original HTTP request info (if applicable)
  requestInfo?: RequestInfo;

  // Send a notification related to this request
  sendNotification: (notification: SendNotificationT) => Promise<void>;

  // Send a request related to this request
  sendRequest: <U extends ZodType<object>>(
    request: SendRequestT,
    resultSchema: U,
    options?: RequestOptions
  ) => Promise<z.infer<U>>;

  // Elicit input from user (if elicitation capability enabled)
  elicitInput?: (request: {
    message: string;
    requestedSchema?: object;
  }) => Promise<ElicitResult>;
}
```

**Key fields:**
- `signal`: Use to detect if the request was cancelled
- `requestId`: Useful for logging/tracking
- `sendNotification`: Send progress updates or other notifications
- `sendRequest`: Make requests back to the server (if needed)

---

## Response Construction

### CreateMessageResult Structure

```typescript
interface CreateMessageResult {
  // Required: Name of the model used
  model: string;

  // Required: Response role (always "assistant")
  role: "assistant";

  // Required: Response content (discriminated union)
  content: TextContent | ImageContent | AudioContent | ToolCallContent;

  // Optional: Why sampling stopped
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | "toolUse" | "refusal" | "other" | string;
}
```

### Basic Text Response Example

```typescript
const result: CreateMessageResult = {
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  content: {
    type: "text",
    text: "This is the LLM's response"
  },
  stopReason: "endTurn"
};
```

---

## Content Types

### 1. TextContent

Plain text response from the LLM.

```typescript
interface TextContent {
  type: "text";
  text: string;
  _meta?: Record<string, unknown>;
}
```

**Example:**
```typescript
content: {
  type: "text",
  text: "The capital of France is Paris."
}
```

### 2. ImageContent

Image data (base64 encoded).

```typescript
interface ImageContent {
  type: "image";
  data: string;        // Base64 encoded image data
  mimeType: string;    // e.g., "image/png", "image/jpeg"
  _meta?: Record<string, unknown>;
}
```

**Example:**
```typescript
content: {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAA...",
  mimeType: "image/png"
}
```

### 3. AudioContent

Audio data (base64 encoded).

```typescript
interface AudioContent {
  type: "audio";
  data: string;        // Base64 encoded audio data
  mimeType: string;    // e.g., "audio/wav", "audio/mp3"
  _meta?: Record<string, unknown>;
}
```

### 4. ToolCallContent (Tool Use)

Request to call a tool. Used when the LLM wants to invoke a tool.

```typescript
interface ToolCallContent {
  type: "tool_use";
  id: string;                              // Unique ID for this tool call
  name: string;                            // Tool name
  input: Record<string, unknown>;          // Tool arguments
  _meta?: Record<string, unknown>;
}
```

**Example:**
```typescript
content: {
  type: "tool_use",
  id: "toolu_01A09q90qw90lq917835lq9",
  name: "get_weather",
  input: {
    location: "San Francisco, CA",
    unit: "celsius"
  }
}
```

When returning `ToolCallContent`, you should typically set `stopReason: "toolUse"`.

---

## Tool Calling Support

### Overview

The sampling API supports tool calling, allowing the LLM to use tools provided by the server. This enables agentic behavior where the LLM can:
1. Decide to use a tool
2. Return a tool call request
3. Receive tool results
4. Continue the conversation

### Tool Definition

Tools are provided in the request's `params.tools` array:

```typescript
interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    // JSON Schema for tool inputs
  };
  outputSchema?: {
    // Optional JSON Schema for tool outputs
  };
}
```

### Tool Choice Configuration

The `tool_choice` parameter controls how the LLM should use tools:

```typescript
interface ToolChoice {
  mode: "auto" | "required" | "tool";
  disable_parallel_tool_use?: boolean;
  toolName?: string;  // Required when mode is "tool"
}
```

**Modes:**
- `"auto"`: LLM decides whether to use tools
- `"required"`: LLM must use at least one tool
- `"tool"`: LLM must use a specific tool (specified by `toolName`)

### Tool Use Flow

1. **Server sends request with tools:**
```typescript
{
  messages: [...],
  maxTokens: 1000,
  tools: [
    {
      name: "get_weather",
      description: "Get current weather",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string" }
        }
      }
    }
  ],
  tool_choice: { mode: "auto" }
}
```

2. **Client returns tool use response:**
```typescript
{
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  content: {
    type: "tool_use",
    id: "toolu_123",
    name: "get_weather",
    input: { location: "Paris" }
  },
  stopReason: "toolUse"
}
```

3. **Server executes tool and adds result to messages:**
```typescript
{
  role: "user",
  content: {
    type: "tool_result",
    toolUseId: "toolu_123",
    content: { temperature: 20, condition: "sunny" }
  }
}
```

4. **Server sends another request with updated messages** (tool loop continues until LLM provides final answer)

---

## Complete Examples

### Example 1: Basic Text Response Handler

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CreateMessageRequestSchema, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";

const client = new Client(
  { name: "basic-client", version: "1.0.0" },
  { capabilities: { sampling: {} } }
);

client.setRequestHandler(
  CreateMessageRequestSchema,
  async (request, extra) => {
    // Check if cancelled
    if (extra.signal.aborted) {
      throw new Error("Request was cancelled");
    }

    console.log(`Handling sampling request with ${request.params.messages.length} messages`);

    // In a real implementation, call your LLM API here
    const response = await callYourLLMAPI({
      messages: request.params.messages,
      maxTokens: request.params.maxTokens,
      systemPrompt: request.params.systemPrompt,
      temperature: request.params.temperature,
    });

    const result: CreateMessageResult = {
      model: response.model,
      role: "assistant",
      content: {
        type: "text",
        text: response.text,
      },
      stopReason: response.stopReason,
    };

    return result;
  }
);
```

### Example 2: Tool Calling Handler

```typescript
import { Anthropic } from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

client.setRequestHandler(
  CreateMessageRequestSchema,
  async (request, extra) => {
    // Convert MCP messages to Anthropic format
    const messages = request.params.messages.map(msg => ({
      role: msg.role,
      content: convertContent(msg.content)
    }));

    // Convert tools to Anthropic format
    const tools = request.params.tools?.map(tool => ({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.inputSchema,
    }));

    // Call Anthropic API
    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      system: request.params.systemPrompt,
      messages: messages,
      max_tokens: request.params.maxTokens,
      temperature: request.params.temperature,
      tools: tools,
    });

    // Convert response to MCP format
    let content: CreateMessageResult['content'];
    let stopReason: CreateMessageResult['stopReason'];

    // Check if LLM wants to use a tool
    const toolUseBlock = response.content.find(block => block.type === 'tool_use');
    if (toolUseBlock) {
      content = {
        type: "tool_use",
        id: toolUseBlock.id,
        name: toolUseBlock.name,
        input: toolUseBlock.input,
      };
      stopReason = "toolUse";
    } else {
      // Regular text response
      const textBlock = response.content.find(block => block.type === 'text');
      content = {
        type: "text",
        text: textBlock?.text || "",
      };
      stopReason = response.stop_reason === "end_turn" ? "endTurn" : response.stop_reason;
    }

    return {
      model: response.model,
      role: "assistant",
      content,
      stopReason,
    };
  }
);
```

### Example 3: Handler with Cancellation Support

```typescript
client.setRequestHandler(
  CreateMessageRequestSchema,
  async (request, extra) => {
    // Set up cancellation handling
    const controller = new AbortController();
    extra.signal.addEventListener('abort', () => {
      controller.abort();
    });

    try {
      const response = await fetch('https://your-llm-api.com/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: request.params.messages,
          max_tokens: request.params.maxTokens,
        }),
        signal: controller.signal,
      });

      const data = await response.json();

      return {
        model: data.model,
        role: "assistant",
        content: {
          type: "text",
          text: data.text,
        },
        stopReason: "endTurn",
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request was cancelled');
      }
      throw error;
    }
  }
);
```

### Example 4: Handler with Progress Notifications

```typescript
client.setRequestHandler(
  CreateMessageRequestSchema,
  async (request, extra) => {
    // Send progress notification
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: extra.requestId,
        progress: 0.5,
        total: 1.0,
      }
    });

    // Perform LLM call...
    const response = await callLLM(request.params);

    // Send completion notification
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: extra.requestId,
        progress: 1.0,
        total: 1.0,
      }
    });

    return {
      model: response.model,
      role: "assistant",
      content: {
        type: "text",
        text: response.text,
      },
      stopReason: "endTurn",
    };
  }
);
```

---

## Best Practices and Gotchas

### Best Practices

1. **Always Declare Capabilities**
   - Declare the `sampling` capability in client options before calling `setRequestHandler`
   - Failure to do so will throw an error at registration time

2. **Validate Input**
   - The SDK automatically validates the request structure via Zod schemas
   - Additional validation of your own business logic should be added

3. **Handle Cancellation**
   - Always check `extra.signal.aborted` before expensive operations
   - Forward the abort signal to your LLM API calls
   - Clean up resources when cancelled

4. **Use Appropriate Stop Reasons**
   - `"endTurn"`: Natural completion
   - `"stopSequence"`: Hit a stop sequence
   - `"maxTokens"`: Reached token limit
   - `"toolUse"`: When returning ToolCallContent
   - `"refusal"`: Model refused the request
   - `"other"`: Provider-specific reasons

5. **Tool Calling Patterns**
   - When returning `ToolCallContent`, set `stopReason: "toolUse"`
   - Generate unique IDs for each tool call (e.g., using UUID)
   - The server will handle executing tools and continuing the conversation

6. **Error Handling**
   - Throw descriptive errors that will be returned to the server
   - The Protocol layer will automatically convert thrown errors to JSON-RPC error responses
   - Use `McpError` for MCP-specific errors with error codes

7. **Model Selection**
   - Use `request.params.modelPreferences` to select appropriate models
   - Fall back to a default model if preferences don't match available models
   - Return the actual model name used in the response

### Common Gotchas

1. **Missing Capability Declaration**
   ```typescript
   // ❌ Wrong - will throw error
   const client = new Client({ name: "client", version: "1.0.0" });
   client.setRequestHandler(CreateMessageRequestSchema, handler);

   // ✅ Correct
   const client = new Client(
     { name: "client", version: "1.0.0" },
     { capabilities: { sampling: {} } }
   );
   client.setRequestHandler(CreateMessageRequestSchema, handler);
   ```

2. **Wrong Content Type for Stop Reason**
   ```typescript
   // ❌ Wrong - stopReason doesn't match content type
   return {
     content: { type: "text", text: "..." },
     stopReason: "toolUse"  // Should be "endTurn" for text
   };

   // ✅ Correct
   return {
     content: { type: "tool_use", id: "...", name: "...", input: {} },
     stopReason: "toolUse"
   };
   ```

3. **Not Handling All Message Types**
   - `SamplingMessage` can be either `UserMessage` or `AssistantMessage`
   - `UserMessage.content` can be: `TextContent`, `ImageContent`, `AudioContent`, or `ToolResultContent`
   - `AssistantMessage.content` can be: `TextContent`, `ImageContent`, `AudioContent`, or `ToolCallContent`
   - Make sure your LLM API supports all content types in the messages

4. **Forgetting Role Field**
   ```typescript
   // ❌ Wrong - missing role
   return {
     model: "claude-3-5-sonnet-20241022",
     content: { type: "text", text: "..." }
   };

   // ✅ Correct
   return {
     model: "claude-3-5-sonnet-20241022",
     role: "assistant",  // Always "assistant"
     content: { type: "text", text: "..." }
   };
   ```

5. **Not Propagating Tool Definitions**
   - When tools are provided in `request.params.tools`, pass them to your LLM API
   - Tools must be in the format expected by your LLM provider
   - Convert between MCP and provider-specific tool formats

6. **Incorrect Tool Result Format**
   - Tool results come as `ToolResultContent` in user messages
   - The `content` field is an object (not an array)
   - Match `toolUseId` with the `id` from `ToolCallContent`

7. **Handler Registration Order**
   - Register handlers before calling `client.connect()`
   - Handlers can only be set once per method (subsequent calls replace the handler)
   - Use `client.removeRequestHandler(method)` to remove a handler

8. **Message History Management**
   - The `messages` array contains the full conversation history
   - Each message has a `role` ("user" or "assistant") and `content`
   - Tool use creates a cycle: assistant tool_use → user tool_result → assistant response

### Type Safety

The SDK uses Zod schemas for runtime validation and TypeScript for compile-time type safety:

```typescript
// Request is automatically typed
client.setRequestHandler(
  CreateMessageRequestSchema,
  async (request, extra) => {
    // ✅ TypeScript knows the structure
    request.params.messages.forEach(msg => {
      if (msg.role === "user") {
        // msg.content can be text, image, audio, or tool_result
      } else {
        // msg.content can be text, image, audio, or tool_use
      }
    });

    // ✅ Return type is validated
    return {
      model: "...",
      role: "assistant",
      content: { type: "text", text: "..." },
      stopReason: "endTurn",
    };
  }
);
```

---

## Related Resources

- **MCP Specification**: [https://modelcontextprotocol.io/docs/specification](https://modelcontextprotocol.io/docs/specification)
- **Client API Source**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/index.ts`
- **Protocol Base**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/shared/protocol.ts`
- **Type Definitions**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts`
- **Example: Tool Loop Sampling**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/toolLoopSampling.ts`
- **Example: Backfill Proxy**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/backfill/backfillSampling.ts`

---

## Summary

The Client Sampling API allows MCP clients to handle `sampling/createMessage` requests from servers, enabling servers to use LLM capabilities without direct API access. Key points:

1. Declare `sampling` capability in client options
2. Register handler using `setRequestHandler(CreateMessageRequestSchema, handler)`
3. Handler receives request with messages, tools, and parameters
4. Return `CreateMessageResult` with model, role, content, and stopReason
5. Support text responses and tool calling
6. Handle cancellation via `extra.signal`
7. Match content types with stop reasons

This API enables powerful patterns like tool loops, agent-based search, and delegated LLM access in MCP architectures.
