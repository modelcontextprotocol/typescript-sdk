# MCP Sampling Analysis: Current Implementation & Tools Support Requirements

## Executive Summary

This document analyzes the current sampling implementation in the MCP TypeScript SDK to understand how to add tools support. The analysis covers:

1. Current sampling API structure
2. Message content type system
3. Existing tool infrastructure
4. Gaps that need to be filled to add tools to sampling

---

## 1. Current Sampling API Structure

### 1.1 CreateMessageRequest

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 1162-1189)

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
  }),
});
```

**Key Parameters:**
- `messages`: Array of SamplingMessage objects (user/assistant conversation history)
- `systemPrompt`: Optional system prompt string
- `includeContext`: Optional context inclusion from MCP servers
- `temperature`: Optional temperature for sampling
- `maxTokens`: Maximum tokens to generate (required)
- `stopSequences`: Optional array of stop sequences
- `metadata`: Optional provider-specific metadata
- `modelPreferences`: Optional model selection preferences

**Note:** Currently NO support for tools parameter.

### 1.2 CreateMessageResult

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 1194-1211)

```typescript
export const CreateMessageResultSchema = ResultSchema.extend({
  model: z.string(),
  stopReason: z.optional(
    z.enum(["endTurn", "stopSequence", "maxTokens"]).or(z.string()),
  ),
  role: z.enum(["user", "assistant"]),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema
  ]),
});
```

**Key Fields:**
- `model`: Name of the model that generated the message
- `stopReason`: Why sampling stopped (endTurn, stopSequence, maxTokens, or custom)
- `role`: Role of the message (user or assistant)
- `content`: Single content block (text, image, or audio)

**Note:** Content is currently a single content block, NOT an array. Also NO support for tool_use or tool_result content types.

### 1.3 SamplingMessage

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 1152-1157)

```typescript
export const SamplingMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([TextContentSchema, ImageContentSchema, AudioContentSchema]),
  })
  .passthrough();
```

**Structure:**
- `role`: Either "user" or "assistant"
- `content`: Single content block (text, image, or audio)

**Note:** Messages in the conversation history also only support single content blocks, not arrays.

### 1.4 How Sampling is Invoked

#### From Server (requesting sampling from client):

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/server/index.ts` (lines 332-341)

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

#### From Client (handling sampling request):

Client must set a request handler for sampling:

```typescript
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  // Client implementation to call LLM
  return {
    model: "test-model",
    role: "assistant",
    content: {
      type: "text",
      text: "This is a test response",
    },
  };
});
```

### 1.5 Sampling Capabilities

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 279-308)

```typescript
export const ClientCapabilitiesSchema = z
  .object({
    experimental: z.optional(z.object({}).passthrough()),
    sampling: z.optional(z.object({}).passthrough()),
    elicitation: z.optional(z.object({}).passthrough()),
    roots: z.optional(
      z.object({
        listChanged: z.optional(z.boolean()),
      }).passthrough(),
    ),
  })
  .passthrough();
```

The `sampling` capability is currently just an empty object. There's no granular capability for "supports tools" or similar.

---

## 2. Message Content Type System

### 2.1 ContentBlock (Used in Prompts & Tool Results)

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 851-857)

```typescript
export const ContentBlockSchema = z.union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ResourceLinkSchema,
  EmbeddedResourceSchema,
]);
```

ContentBlock is used in:
- Prompt messages (`PromptMessageSchema`)
- Tool call results (`CallToolResultSchema`)

### 2.2 Available Content Types

#### TextContent

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 762-776)

```typescript
export const TextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    _meta: z.optional(z.object({}).passthrough()),
  })
  .passthrough();
```

#### ImageContent

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 781-799)

```typescript
export const ImageContentSchema = z
  .object({
    type: z.literal("image"),
    data: Base64Schema,
    mimeType: z.string(),
    _meta: z.optional(z.object({}).passthrough()),
  })
  .passthrough();
```

#### AudioContent

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 804-822)

```typescript
export const AudioContentSchema = z
  .object({
    type: z.literal("audio"),
    data: Base64Schema,
    mimeType: z.string(),
    _meta: z.optional(z.object({}).passthrough()),
  })
  .passthrough();
```

#### EmbeddedResource

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 827-837)

```typescript
export const EmbeddedResourceSchema = z
  .object({
    type: z.literal("resource"),
    resource: z.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
    _meta: z.optional(z.object({}).passthrough()),
  })
  .passthrough();
```

#### ResourceLink

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 844-846)

```typescript
export const ResourceLinkSchema = ResourceSchema.extend({
  type: z.literal("resource_link"),
});
```

### 2.3 Content Type Differences

**Important Distinction:**

1. **SamplingMessage content**: Single content block (text, image, or audio only)
2. **ContentBlock**: Used in prompts & tool results (includes resource types)
3. **CallToolResult content**: Array of ContentBlock

---

## 3. Tool Infrastructure

### 3.1 Tool Definition

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 947-984)

```typescript
export const ToolSchema = BaseMetadataSchema.extend({
  description: z.optional(z.string()),
  inputSchema: z
    .object({
      type: z.literal("object"),
      properties: z.optional(z.object({}).passthrough()),
      required: z.optional(z.array(z.string())),
    })
    .passthrough(),
  outputSchema: z.optional(
    z.object({
      type: z.literal("object"),
      properties: z.optional(z.object({}).passthrough()),
      required: z.optional(z.array(z.string())),
    })
      .passthrough()
  ),
  annotations: z.optional(ToolAnnotationsSchema),
  _meta: z.optional(z.object({}).passthrough()),
}).merge(IconsSchema);
```

**Key Fields:**
- `name`: Tool name (from BaseMetadataSchema)
- `title`: Optional display title
- `description`: Tool description
- `inputSchema`: JSON Schema for tool input
- `outputSchema`: Optional JSON Schema for tool output
- `annotations`: Optional hints about tool behavior
- `icons`: Optional icons

### 3.2 CallToolRequest

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 1048-1054)

```typescript
export const CallToolRequestSchema = RequestSchema.extend({
  method: z.literal("tools/call"),
  params: BaseRequestParamsSchema.extend({
    name: z.string(),
    arguments: z.optional(z.record(z.unknown())),
  }),
});
```

**Structure:**
- `name`: Tool name to call
- `arguments`: Optional record of arguments

### 3.3 CallToolResult

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 1003-1034)

```typescript
export const CallToolResultSchema = ResultSchema.extend({
  content: z.array(ContentBlockSchema).default([]),
  structuredContent: z.object({}).passthrough().optional(),
  isError: z.optional(z.boolean()),
});
```

**Key Fields:**
- `content`: Array of ContentBlock (text, image, audio, resource, resource_link)
- `structuredContent`: Optional structured output (if outputSchema defined)
- `isError`: Whether the tool call resulted in an error

### 3.4 How Tools are Used

#### Server Side (providing tools):

**Example from:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/server/mcp.ts`

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
    // Tool implementation
    return {
      content: [
        {
          type: "text",
          text: "Summary result",
        },
      ],
    };
  }
);
```

#### Client Side (calling tools):

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/index.ts` (lines 429-479)

```typescript
async callTool(
  params: CallToolRequest["params"],
  resultSchema:
    | typeof CallToolResultSchema
    | typeof CompatibilityCallToolResultSchema = CallToolResultSchema,
  options?: RequestOptions,
) {
  const result = await this.request(
    { method: "tools/call", params },
    resultSchema,
    options,
  );

  // Validate structuredContent against outputSchema if present
  const validator = this.getToolOutputValidator(params.name);
  if (validator) {
    if (!result.structuredContent && !result.isError) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool ${params.name} has an output schema but did not return structured content`
      );
    }

    if (result.structuredContent) {
      const isValid = validator(result.structuredContent);
      if (!isValid) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Structured content does not match the tool's output schema`
        );
      }
    }
  }

  return result;
}
```

The client caches tool output schemas from `listTools()` and validates results.

### 3.5 Tool Capabilities

**Location:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/types.ts` (lines 377-388)

```typescript
tools: z.optional(
  z
    .object({
      listChanged: z.optional(z.boolean()),
    })
    .passthrough(),
),
```

Server advertises `tools` capability to indicate it provides tools.

---

## 4. Gaps to Fill for Tools in Sampling

### 4.1 Missing Content Types

The current sampling system lacks content types for tool usage:

**Need to add:**

1. **ToolUseContent** - Represents a tool call from the LLM
   - Should include: tool name, tool call ID, arguments

2. **ToolResultContent** - Represents the result of a tool call
   - Should include: tool call ID, result content, error status

**Example structure (based on Anthropic's API):**

```typescript
// Tool use content
{
  type: "tool_use",
  id: "tool_call_123",
  name: "get_weather",
  input: { city: "San Francisco" }
}

// Tool result content
{
  type: "tool_result",
  tool_use_id: "tool_call_123",
  content: "Weather is sunny, 72°F"
}
```

### 4.2 Content Array Support

**Current Issue:**
- `SamplingMessage.content` is a single content block
- `CreateMessageResult.content` is a single content block

**Need to change:**
- Support array of content blocks to allow multiple tool calls in one message
- Or support both single and array (discriminated union based on whether tools are used)

**Example:**
```typescript
// Assistant message with multiple tool calls
{
  role: "assistant",
  content: [
    { type: "text", text: "Let me check the weather..." },
    { type: "tool_use", id: "1", name: "get_weather", input: { city: "SF" } },
    { type: "tool_use", id: "2", name: "get_weather", input: { city: "NYC" } }
  ]
}

// User response with tool results
{
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "1", content: "72°F, sunny" },
    { type: "tool_result", tool_use_id: "2", content: "65°F, cloudy" }
  ]
}
```

### 4.3 Tools Parameter in Request

**Current Issue:**
`CreateMessageRequestSchema` has no `tools` parameter.

**Need to add:**
```typescript
tools: z.optional(z.array(ToolSchema))
```

This allows the server to specify which tools are available to the LLM during sampling.

### 4.4 Tool Use in Stop Reason

**Current Issue:**
`stopReason` enum is: `["endTurn", "stopSequence", "maxTokens"]`

**Need to add:**
`"tool_use"` as a valid stop reason to indicate the LLM wants to call tools.

### 4.5 Tool Choice Parameter

**Missing Feature:**
No way to control whether/how tools are used.

**Should consider adding:**
```typescript
tool_choice: z.optional(
  z.union([
    z.literal("auto"),      // LLM decides
    z.literal("required"),  // Must use a tool
    z.literal("none"),      // Don't use tools
    z.object({              // Force specific tool
      type: z.literal("tool"),
      name: z.string()
    })
  ])
)
```

### 4.6 Example Flow with Tools

**1. Server requests sampling with tools:**
```typescript
await server.createMessage({
  messages: [
    {
      role: "user",
      content: { type: "text", text: "What's the weather in SF?" }
    }
  ],
  tools: [
    {
      name: "get_weather",
      description: "Get current weather",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" }
        },
        required: ["city"]
      }
    }
  ],
  maxTokens: 1000
})
```

**2. Client/LLM responds with tool use:**
```typescript
{
  model: "claude-3-5-sonnet",
  role: "assistant",
  stopReason: "tool_use",
  content: [
    {
      type: "text",
      text: "I'll check the weather for you."
    },
    {
      type: "tool_use",
      id: "tool_123",
      name: "get_weather",
      input: { city: "San Francisco" }
    }
  ]
}
```

**3. Server calls the tool and continues conversation:**
```typescript
// Server calls its own tool
const toolResult = await callTool({
  name: "get_weather",
  arguments: { city: "San Francisco" }
});

// Continue the conversation with tool result
await server.createMessage({
  messages: [
    {
      role: "user",
      content: { type: "text", text: "What's the weather in SF?" }
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll check the weather for you." },
        { type: "tool_use", id: "tool_123", name: "get_weather", input: { city: "San Francisco" } }
      ]
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_123", content: "72°F, sunny" }
      ]
    }
  ],
  tools: [...],
  maxTokens: 1000
})
```

**4. Final LLM response:**
```typescript
{
  model: "claude-3-5-sonnet",
  role: "assistant",
  stopReason: "endTurn",
  content: {
    type: "text",
    text: "The weather in San Francisco is currently 72°F and sunny!"
  }
}
```

---

## 5. Implementation Considerations

### 5.1 Backward Compatibility

The changes need to maintain backward compatibility with existing implementations that don't use tools.

**Approach:**
1. Make `tools` parameter optional
2. Support both single content and array content (discriminated union or always array)
3. Add new content types without breaking existing ones
4. Ensure existing code without tools continues to work

### 5.2 Content Structure Decision

**Option A: Always use array**
```typescript
content: z.array(
  z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolUseContentSchema,
    ToolResultContentSchema
  ])
)
```

**Option B: Union of single or array**
```typescript
content: z.union([
  // Single content (backward compatible)
  z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
  ]),
  // Array content (for tools)
  z.array(
    z.discriminatedUnion("type", [
      TextContentSchema,
      ImageContentSchema,
      AudioContentSchema,
      ToolUseContentSchema,
      ToolResultContentSchema
    ])
  )
])
```

**Recommendation:** Option A (always array) is cleaner but requires migration. Option B maintains perfect backward compatibility.

### 5.3 Validation

The client will need to validate:
1. Tool definitions match expected schema
2. Tool use IDs are unique
3. Tool result IDs match previous tool uses
4. Tool names in tool_use match provided tools

### 5.4 Error Handling

Need to define behavior for:
1. Tool not found
2. Invalid tool arguments
3. Tool execution errors
4. Missing tool results
5. Mismatched tool_use_id references

---

## 6. Related Code Paths

### 6.1 Test Coverage

**Key test files:**
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/server/index.test.ts` - Server sampling tests (lines 208-270)
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/index.test.ts` - Client tool validation tests (lines 834-1303)

The client already has extensive tests for tool output schema validation. Similar tests will be needed for tool usage in sampling.

### 6.2 Example Usage

**Current example:** `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/toolWithSampleServer.ts`

This shows a tool that uses sampling internally. With tools support in sampling, this pattern becomes more powerful - a tool can call the LLM which can in turn call other tools.

---

## 7. Summary

### What Currently Works:
- Basic sampling (text, image, audio)
- Tool definitions and tool calling (separate from sampling)
- Tool output schema validation
- Message history with roles

### What Needs to be Added:
1. **New content types:** ToolUseContent, ToolResultContent
2. **Array content support:** Messages need to support multiple content blocks
3. **Tools parameter:** CreateMessageRequest needs tools array
4. **Tool choice parameter:** Optional control over tool usage
5. **Stop reason:** Add "tool_use" to valid stop reasons
6. **Validation logic:** Ensure tool use/result consistency
7. **Documentation:** Update examples and guides

### Critical Design Decisions:
1. Content array vs union approach for backward compatibility
2. Tool_use_id generation: client or server responsibility?
3. Error handling strategy for tool-related errors
4. Capability negotiation: extend sampling capability or add new sub-capabilities?

---

## 8. Next Steps

1. Review MCP specification for tools in sampling (if exists)
2. Decide on content structure approach (array vs union)
3. Define new Zod schemas for tool content types
4. Update CreateMessageRequest and CreateMessageResult schemas
5. Implement validation logic
6. Write comprehensive tests
7. Update documentation and examples
8. Consider migration guide for existing users

---

**Document created:** 2025-10-01
**SDK Version:** Based on commit 856d9ec (post v1.18.2)
**Analysis completed by:** Claude (AI Assistant)
