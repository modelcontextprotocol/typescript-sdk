# Sampling Tool Call Additions Analysis (SEP-1577)

## Summary of Changes

The branch `ochafik/sep1577` implements comprehensive tool calling support for MCP sampling (SEP-1577). This enables agentic workflows where LLMs can request tool execution during sampling operations. The changes include:

1. **New content types** for tool calls and results in messages
2. **Role-specific message types** (UserMessage, AssistantMessage) with appropriate content types
3. **Tool choice controls** to specify when/how tools should be used
4. **Extended sampling requests** with tools and tool_choice parameters
5. **Extended sampling responses** with new stop reasons including "toolUse"
6. **Client capabilities** signaling for tool support
7. **Complete example implementation** in the backfill sampling proxy

## Key Types and Interfaces Added

### 1. ToolCallContent (Assistant → User)

Represents the LLM's request to use a tool. This appears in assistant messages.

```typescript
export const ToolCallContentSchema = z.object({
  type: z.literal("tool_use"),
  /**
   * The name of the tool to invoke.
   * Must match a tool name from the request's tools array.
   */
  name: z.string(),
  /**
   * Unique identifier for this tool call.
   * Used to correlate with ToolResultContent in subsequent messages.
   */
  id: z.string(),
  /**
   * Arguments to pass to the tool.
   * Must conform to the tool's inputSchema.
   */
  input: z.object({}).passthrough(),
  /**
   * Optional metadata
   */
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;
```

**Example:**
```typescript
{
  type: "tool_use",
  id: "call_123",
  name: "get_weather",
  input: { city: "San Francisco", units: "celsius" }
}
```

### 2. ToolResultContent (User → Assistant)

Represents the result of executing a tool. This appears in user messages to provide tool execution results back to the LLM.

```typescript
export const ToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  /**
   * The ID of the tool call this result corresponds to.
   * Must match a ToolCallContent.id from a previous assistant message.
   */
  toolUseId: z.string(),
  /**
   * The result of the tool execution.
   * Can be any JSON-serializable object.
   * Error information should be included in the content itself.
   */
  content: z.object({}).passthrough(),
  /**
   * Optional metadata
   */
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export type ToolResultContent = z.infer<typeof ToolResultContentSchema>;
```

**Example (success):**
```typescript
{
  type: "tool_result",
  toolUseId: "call_123",
  content: { temperature: 72, condition: "sunny", units: "fahrenheit" }
}
```

**Example (error in content):**
```typescript
{
  type: "tool_result",
  toolUseId: "call_123",
  content: { error: "API_ERROR", message: "Service unavailable" }
}
```

**Important:** Errors are represented directly in the `content` object, not via a separate `isError` field. This aligns with Claude and OpenAI APIs.

### 3. ToolChoice

Controls when and how tools are used during sampling.

```typescript
export const ToolChoiceSchema = z.object({
  /**
   * Controls when tools are used:
   * - "auto": Model decides whether to use tools (default)
   * - "required": Model MUST use at least one tool before completing
   */
  mode: z.optional(z.enum(["auto", "required"])),
  /**
   * If true, model should not use multiple tools in parallel.
   * Some models may ignore this hint.
   * Default: false
   */
  disable_parallel_tool_use: z.optional(z.boolean()),
}).passthrough();

export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
```

**Examples:**
```typescript
// Let model decide
{ mode: "auto" }

// Force tool use
{ mode: "required" }

// Sequential tool calls only
{ mode: "auto", disable_parallel_tool_use: true }
```

### 4. Role-Specific Message Types

Messages are now split by role, with each role allowing specific content types:

#### UserMessage
```typescript
export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolResultContentSchema,  // NEW: Users provide tool results
  ]),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export type UserMessage = z.infer<typeof UserMessageSchema>;
```

#### AssistantMessage
```typescript
export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,  // NEW: Assistants request tool use
  ]),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
```

#### SamplingMessage
```typescript
export const SamplingMessageSchema = z.discriminatedUnion("role", [
  UserMessageSchema,
  AssistantMessageSchema,
]);

export type SamplingMessage = z.infer<typeof SamplingMessageSchema>;
```

### 5. CreateMessageRequest (Extended)

The sampling request now supports tools:

```typescript
export const CreateMessageRequestSchema = RequestSchema.extend({
  method: z.literal("sampling/createMessage"),
  params: BaseRequestParamsSchema.extend({
    messages: z.array(SamplingMessageSchema),
    systemPrompt: z.optional(z.string()),
    temperature: z.optional(z.number()),
    maxTokens: z.number().int(),
    stopSequences: z.optional(z.array(z.string())),
    metadata: z.optional(z.object({}).passthrough()),
    modelPreferences: z.optional(ModelPreferencesSchema),

    // NEW: Tool support
    /**
     * Tool definitions for the LLM to use.
     * Requires clientCapabilities.sampling.tools.
     */
    tools: z.optional(z.array(ToolSchema)),

    /**
     * Controls tool usage behavior.
     * Requires clientCapabilities.sampling.tools and tools parameter.
     */
    tool_choice: z.optional(ToolChoiceSchema),

    // SOFT-DEPRECATED: Use tools parameter instead
    includeContext: z.optional(z.enum(["none", "thisServer", "allServers"])),
  }),
});

export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
```

**Example request:**
```typescript
{
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "What's the weather in San Francisco?" }
      }
    ],
    maxTokens: 1000,
    tools: [
      {
        name: "get_weather",
        description: "Get current weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] }
          },
          required: ["city"]
        }
      }
    ],
    tool_choice: { mode: "auto" }
  }
}
```

### 6. CreateMessageResult (Extended)

The sampling response now supports tool use stop reasons and tool call content:

```typescript
export const CreateMessageResultSchema = ResultSchema.extend({
  /**
   * The name of the model that generated the message.
   */
  model: z.string(),

  /**
   * The reason why sampling stopped.
   * - "endTurn": Model completed naturally
   * - "stopSequence": Hit a stop sequence
   * - "maxTokens": Reached token limit
   * - "toolUse": Model wants to use a tool  // NEW
   * - "refusal": Model refused the request  // NEW
   * - "other": Other provider-specific reason  // NEW
   */
  stopReason: z.optional(
    z.enum(["endTurn", "stopSequence", "maxTokens", "toolUse", "refusal", "other"])
      .or(z.string())
  ),

  /**
   * Always "assistant" for sampling responses
   */
  role: z.literal("assistant"),

  /**
   * Response content. May be ToolCallContent if stopReason is "toolUse".
   */
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,  // NEW
  ]),
});

export type CreateMessageResult = z.infer<typeof CreateMessageResultSchema>;
```

**Example response with tool call:**
```typescript
{
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  content: {
    type: "tool_use",
    id: "call_abc123",
    name: "get_weather",
    input: { city: "San Francisco", units: "celsius" }
  },
  stopReason: "toolUse"
}
```

### 7. Client Capabilities

Signal tool support in capabilities:

```typescript
export const ClientCapabilitiesSchema = z.object({
  sampling: z.optional(
    z.object({
      /**
       * Present if the client supports non-'none' values for includeContext.
       * SOFT-DEPRECATED: New implementations should use tools parameter instead.
       */
      context: z.optional(z.object({}).passthrough()),

      /**
       * Present if the client supports tools and tool_choice parameters.
       * Presence indicates full tool calling support.
       */
      tools: z.optional(z.object({}).passthrough()),  // NEW
    }).passthrough()
  ),
  // ... other capabilities
}).passthrough();
```

**Example:**
```typescript
{
  sampling: {
    tools: {}  // Indicates client supports tool calling
  }
}
```

## How the Tool Call Loop Works

The tool calling flow follows this pattern:

### 1. Initial Request with Tools

Server sends a sampling request with available tools:

```typescript
{
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "What's the weather in SF?" }
      }
    ],
    maxTokens: 1000,
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] }
          },
          required: ["city"]
        }
      }
    ],
    tool_choice: { mode: "auto" }
  }
}
```

### 2. LLM Responds with Tool Call

Client/LLM decides to use a tool and responds:

```typescript
{
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  content: {
    type: "tool_use",
    id: "toolu_01A2B3C4D5",
    name: "get_weather",
    input: { city: "San Francisco", units: "celsius" }
  },
  stopReason: "toolUse"
}
```

### 3. Server Executes Tool

Server receives tool call, executes the tool (e.g., calls weather API), and sends another request with the result:

```typescript
{
  method: "sampling/createMessage",
  params: {
    messages: [
      // Original user message
      {
        role: "user",
        content: { type: "text", text: "What's the weather in SF?" }
      },
      // Assistant's tool call
      {
        role: "assistant",
        content: {
          type: "tool_use",
          id: "toolu_01A2B3C4D5",
          name: "get_weather",
          input: { city: "San Francisco", units: "celsius" }
        }
      },
      // Tool result from server
      {
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: "toolu_01A2B3C4D5",
          content: {
            temperature: 18,
            condition: "partly cloudy",
            humidity: 65
          }
        }
      }
    ],
    maxTokens: 1000,
    tools: [...],  // Same tools as before
    tool_choice: { mode: "auto" }
  }
}
```

### 4. LLM Provides Final Answer

Client/LLM uses the tool result to provide a final answer:

```typescript
{
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  content: {
    type: "text",
    text: "The weather in San Francisco is currently 18°C and partly cloudy with 65% humidity."
  },
  stopReason: "endTurn"
}
```

## Implementation Example

The `backfillSampling.ts` example demonstrates a complete implementation. Key conversion functions:

### Tool Definition Conversion
```typescript
function toolToClaudeFormat(tool: Tool): ClaudeTool {
  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema,
  };
}
```

### Tool Choice Conversion
```typescript
function toolChoiceToClaudeFormat(
  toolChoice: CreateMessageRequest['params']['tool_choice']
): ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | undefined {
  if (!toolChoice) return undefined;

  if (toolChoice.mode === "required") {
    return {
      type: "any",
      disable_parallel_tool_use: toolChoice.disable_parallel_tool_use
    };
  }

  return {
    type: "auto",
    disable_parallel_tool_use: toolChoice.disable_parallel_tool_use
  };
}
```

### Content Conversion (Claude → MCP)
```typescript
function contentToMcp(content: ContentBlock): CreateMessageResult['content'] {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: content.id,
        name: content.name,
        input: content.input,
      } as ToolCallContent;
    default:
      throw new Error(`Unsupported content type: ${(content as any).type}`);
  }
}
```

### Content Conversion (MCP → Claude)
```typescript
function contentFromMcp(
  content: UserMessage['content'] | AssistantMessage['content']
): ContentBlockParam {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text };
    case 'image':
      return {
        type: 'image',
        source: {
          data: content.data,
          media_type: content.mimeType as Base64ImageSource['media_type'],
          type: 'base64',
        },
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: content.toolUseId,
        content: JSON.stringify(content.content),
      };
    default:
      throw new Error(`Unsupported content type: ${(content as any).type}`);
  }
}
```

### Stop Reason Mapping
```typescript
let stopReason: CreateMessageResult['stopReason'] = msg.stop_reason as any;
if (msg.stop_reason === 'tool_use') {
  stopReason = 'toolUse';
} else if (msg.stop_reason === 'max_tokens') {
  stopReason = 'maxTokens';
} else if (msg.stop_reason === 'end_turn') {
  stopReason = 'endTurn';
} else if (msg.stop_reason === 'stop_sequence') {
  stopReason = 'stopSequence';
}
```

## Testing

The implementation includes comprehensive tests in `src/types.test.ts`:

- ToolCallContent validation (with/without _meta, error cases)
- ToolResultContent validation (success, errors in content, missing fields)
- ToolChoice validation (auto, required, parallel control)
- UserMessage/AssistantMessage with tool content types
- CreateMessageRequest with tools and tool_choice
- CreateMessageResult with tool calls and new stop reasons
- All new stop reasons: endTurn, stopSequence, maxTokens, toolUse, refusal, other
- Custom stop reason strings

Total: 27 new test cases added, all passing (47/47 in types.test.ts, 683/683 overall).

## Key Design Decisions

1. **No `isError` field**: Errors are represented in the `content` object itself, matching Claude/OpenAI APIs
2. **Role-specific content types**: UserMessage can have tool_result, AssistantMessage can have tool_use
3. **Discriminated unions**: Both messages and content use discriminated unions for type safety
4. **Soft deprecation**: `includeContext` is soft-deprecated in favor of explicit `tools` parameter
5. **Extensible stop reasons**: Stop reasons are an enum but also allow arbitrary strings for provider-specific reasons
6. **Tool correlation**: Tool calls and results are linked via unique IDs (id/toolUseId)

## Client Capabilities Check

Before using tools in sampling requests, verify the client supports them:

```typescript
// In server code
if (client.getServerCapabilities()?.sampling?.tools) {
  // Client supports tool calling
  // Can send CreateMessageRequest with tools parameter
}
```

## Migration Notes

For existing code using sampling without tools:
- No breaking changes - tools are optional
- `includeContext` still works but is soft-deprecated
- All existing sampling requests continue to work unchanged
- To add tool support:
  1. Add `sampling.tools = {}` to client capabilities
  2. Include `tools` array in CreateMessageRequest.params
  3. Optionally include `tool_choice` to control tool usage
  4. Handle ToolCallContent in responses
  5. Send ToolResultContent in follow-up requests

## Related Files

- **Type definitions**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts`
- **Client implementation**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/index.ts`
- **Protocol base**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/shared/protocol.ts`
- **Example implementation**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/backfill/backfillSampling.ts`
- **Tests**: `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.test.ts`

## Summary

SEP-1577 adds comprehensive, type-safe tool calling support to MCP sampling. The implementation:
- ✅ Introduces new content types (ToolCallContent, ToolResultContent)
- ✅ Splits messages by role with appropriate content types
- ✅ Adds tool choice controls
- ✅ Extends sampling request/response schemas
- ✅ Includes client capability signaling
- ✅ Provides complete example implementation
- ✅ Has comprehensive test coverage
- ✅ Maintains backward compatibility
- ✅ Aligns with Claude and OpenAI API conventions

The tool loop enables agentic workflows where servers can provide tools to LLMs, have the LLM request tool execution, execute those tools, and provide results back to the LLM for final answers.
