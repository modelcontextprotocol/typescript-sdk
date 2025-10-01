# SEP-1577: Sampling With Tools - Complete Technical Specification

**Research Date:** 2025-10-01
**Status:** Draft SEP
**Source:** https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577
**Author:** Olivier Chafik (@ochafik)
**Sponsor:** @bhosmer-ant
**Target Spec Version:** MCP 2025-06-18

---

## Executive Summary

SEP-1577 introduces tool calling support to MCP's `sampling/createMessage` request, enabling MCP servers to run agentic loops using client LLM tokens. This enhancement addresses three key issues:
1. Lack of tool calling support in current sampling implementation
2. Ambiguous definition of context inclusion parameters
3. Low adoption of sampling features by MCP clients

The specification soft-deprecates the `includeContext` parameter in favor of explicit tool definitions and introduces new capability negotiation requirements.

---

## 1. Motivation and Background

### Current Problems

1. **No Tool Support**: Current `sampling/createMessage` lacks tool calling capability, limiting agentic workflows
2. **Ambiguous Context Inclusion**: The `includeContext` parameter's behavior is poorly defined and inconsistently implemented
3. **Low Client Adoption**: Complex and ambiguous requirements have led to minimal client support

### Goals

- Enable servers to orchestrate multi-step tool-based workflows using client LLM access
- Standardize tool calling across different AI model providers
- Simplify client implementation requirements
- Maintain backwards compatibility with existing implementations

### Related Discussions

- Discussion #124: "Improve sampling in the protocol"
- Issue #503: "Reframe sampling as a basis for bidirectional agent-to-agent communication"
- Discussion #314: "Task semantics and multi-turn interactions with tools"

---

## 2. Type Definitions

### 2.1 Client Capabilities

**Updated Schema:**

```typescript
interface ClientCapabilities {
  sampling?: {
    /**
     * If present, client supports non-'none' values for includeContext parameter.
     * Soft-deprecated - new implementations should use tools parameter instead.
     */
    context?: object;

    /**
     * If present, client supports tools and tool_choice parameters.
     * Presence of this capability indicates full tool calling support.
     */
    tools?: object;
  };
  // ... other capabilities
}
```

**Capability Negotiation Rules:**

1. If `sampling.tools` is NOT present:
   - Server MUST NOT include `tools` or `tool_choice` in `CreateMessageRequest`
   - Server MUST throw error if it requires tool support

2. If `sampling.context` is NOT present:
   - Server MUST NOT use `includeContext` with values `"thisServer"` or `"allServers"`
   - Server MAY use `includeContext: "none"` (default behavior)

3. Servers SHOULD prefer `tools` over `includeContext` when both are available

---

### 2.2 Tool-Related Types

#### ToolChoice

```typescript
interface ToolChoice {
  /**
   * Controls when tools are used:
   * - "auto": Model decides whether to use tools (default)
   * - "required": Model MUST use at least one tool before completing
   */
  mode?: "auto" | "required";

  /**
   * If true, model should not use multiple tools in parallel.
   * Some models may ignore this hint.
   * Default: false
   */
  disable_parallel_tool_use?: boolean;
}
```

**Notes:**
- `mode` defaults to `"auto"` if not specified
- `disable_parallel_tool_use` is a hint, not a guarantee
- Future extensions may add tool-specific selection (e.g., `{"type": "tool", "name": "search"}`)

#### Tool (Reference)

The existing `Tool` type from `tools/list` is reused:

```typescript
interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  outputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  icons?: Icon[];
}
```

**Important:** Tools passed in sampling requests use the same schema as `tools/list` responses.

---

### 2.3 New Content Types

#### ToolCallContent

Represents a tool invocation request from the assistant.

```typescript
interface ToolCallContent {
  /**
   * Discriminator for content type
   */
  type: "tool_use";

  /**
   * The name of the tool to invoke.
   * Must match a tool name from the request's tools array.
   */
  name: string;

  /**
   * Unique identifier for this tool call.
   * Used to correlate with ToolResultContent in subsequent messages.
   */
  id: string;

  /**
   * Arguments to pass to the tool.
   * Must conform to the tool's inputSchema.
   */
  input: object;

  /**
   * Optional metadata
   */
  _meta?: Record<string, unknown>;
}
```

**Validation Rules:**
- `name` MUST reference a tool from the request's `tools` array
- `id` MUST be unique within the conversation
- `input` MUST validate against the tool's `inputSchema`
- `id` format is provider-specific (commonly UUIDs or sequential IDs)

**Zod Schema:**

```typescript
const ToolCallContentSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  id: z.string(),
  input: z.object({}).passthrough(),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();
```

#### ToolResultContent

Represents the result of a tool execution, sent by the user (server).

```typescript
interface ToolResultContent {
  /**
   * Discriminator for content type
   */
  type: "tool_result";

  /**
   * The ID of the tool call this result corresponds to.
   * Must match a ToolCallContent.id from a previous assistant message.
   */
  toolUseId: string;

  /**
   * The result of the tool execution.
   * Can be any JSON-serializable object.
   * May include error information if the tool failed.
   */
  content: object;

  /**
   * If true, indicates the tool execution failed.
   * The content should contain error details.
   * Default: false
   */
  isError?: boolean;

  /**
   * Optional metadata
   */
  _meta?: Record<string, unknown>;
}
```

**Validation Rules:**
- `toolUseId` MUST reference a previous `ToolCallContent.id` in the conversation
- All `ToolCallContent` instances MUST have corresponding `ToolResultContent` responses
- `content` SHOULD validate against the tool's `outputSchema` if defined
- If `isError` is true, `content` SHOULD contain error explanation

**Zod Schema:**

```typescript
const ToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.object({}).passthrough(),
  isError: z.optional(z.boolean()),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();
```

---

### 2.4 Message Types

#### SamplingMessage (Updated)

```typescript
type SamplingMessage = UserMessage | AssistantMessage;

interface UserMessage {
  role: "user";
  content:
    | TextContent
    | ImageContent
    | AudioContent
    | ToolResultContent;  // NEW
  _meta?: Record<string, unknown>;
}

interface AssistantMessage {
  role: "assistant";
  content:
    | TextContent
    | ImageContent
    | AudioContent
    | ToolCallContent;  // NEW
  _meta?: Record<string, unknown>;
}
```

**Key Changes from Current Implementation:**

1. **Split Message Types**: `SamplingMessage` is now a discriminated union of `UserMessage` and `AssistantMessage`
   - Current: Single type with both roles
   - New: Separate types with role-specific content

2. **New Content Types**:
   - `UserMessage` can contain `ToolResultContent`
   - `AssistantMessage` can contain `ToolCallContent`

3. **Content Structure**:
   - Current: `content` is a single union type
   - New: `content` is role-specific union type

**Backwards Compatibility:**
- Existing messages without tool content remain valid
- Parsers MUST handle both old and new content types
- Servers MUST validate role-content compatibility

**Zod Schemas:**

```typescript
const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolResultContentSchema,
  ]),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.union([
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,
  ]),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

const SamplingMessageSchema = z.union([
  UserMessageSchema,
  AssistantMessageSchema,
]);
```

---

### 2.5 Request and Result Updates

#### CreateMessageRequest (Updated)

```typescript
interface CreateMessageRequest {
  method: "sampling/createMessage";
  params: {
    messages: SamplingMessage[];

    /**
     * System prompt for the LLM.
     * Client MAY modify or omit this.
     */
    systemPrompt?: string;

    /**
     * SOFT-DEPRECATED: Use tools parameter instead.
     * Request to include context from MCP servers.
     * Requires clientCapabilities.sampling.context.
     */
    includeContext?: "none" | "thisServer" | "allServers";

    /**
     * Temperature for sampling (0.0 to 1.0+)
     */
    temperature?: number;

    /**
     * Maximum tokens to generate
     */
    maxTokens: number;

    /**
     * Stop sequences
     */
    stopSequences?: string[];

    /**
     * Provider-specific metadata
     */
    metadata?: object;

    /**
     * Model selection preferences
     */
    modelPreferences?: ModelPreferences;

    /**
     * NEW: Tool definitions for the LLM to use.
     * Requires clientCapabilities.sampling.tools.
     */
    tools?: Tool[];

    /**
     * NEW: Controls tool usage behavior.
     * Requires clientCapabilities.sampling.tools.
     */
    tool_choice?: ToolChoice;

    /**
     * Request metadata
     */
    _meta?: {
      progressToken?: string | number;
    };
  };
}
```

**Parameter Requirements:**

| Parameter | Required | Capability Required | Notes |
|-----------|----------|-------------------|-------|
| `messages` | Yes | None | Must be non-empty |
| `maxTokens` | Yes | None | Must be positive integer |
| `systemPrompt` | No | None | Client may override |
| `temperature` | No | None | Typically 0.0-1.0 |
| `stopSequences` | No | None | |
| `metadata` | No | None | Provider-specific |
| `modelPreferences` | No | None | |
| `includeContext` | No | `sampling.context` | Soft-deprecated |
| `tools` | No | `sampling.tools` | New in SEP-1577 |
| `tool_choice` | No | `sampling.tools` | Requires `tools` |

#### CreateMessageResult (Updated)

```typescript
interface CreateMessageResult {
  /**
   * The model that generated the response
   */
  model: string;

  /**
   * Why sampling stopped.
   * NEW VALUES: "toolUse", "refusal", "other"
   */
  stopReason?:
    | "endTurn"      // Model completed naturally
    | "stopSequence" // Hit a stop sequence
    | "maxTokens"    // Reached token limit (RENAMED from "maxToken")
    | "toolUse"      // NEW: Model wants to use a tool
    | "refusal"      // NEW: Model refused the request
    | "other"        // NEW: Other provider-specific reason
    | string;        // Allow extension

  /**
   * Role is always "assistant" in responses
   */
  role: "assistant";

  /**
   * Response content.
   * May be ToolCallContent if stopReason is "toolUse"
   */
  content:
    | TextContent
    | ImageContent
    | AudioContent
    | ToolCallContent;  // NEW

  /**
   * Result metadata
   */
  _meta?: Record<string, unknown>;
}
```

**Stop Reason Semantics:**

| Stop Reason | Meaning | Expected Content Type | Server Action |
|-------------|---------|---------------------|---------------|
| `endTurn` | Natural completion | Text/Image/Audio | Conversation complete |
| `stopSequence` | Hit stop sequence | Text | Conversation may continue |
| `maxTokens` | Token limit reached | Text/Image/Audio | May be incomplete |
| `toolUse` | Tool call requested | ToolCallContent | Server MUST execute tool |
| `refusal` | Request refused | Text (explanation) | Handle refusal |
| `other` | Provider-specific | Any | Check provider docs |

**Key Changes:**

1. `stopReason` expanded with 3 new values
2. `maxToken` renamed to `maxTokens` (note the 's')
3. `content` can now be `ToolCallContent`
4. `role` is fixed as `"assistant"` (no longer enum with both)

---

## 3. Protocol Requirements

### 3.1 Server Requirements

#### Capability Validation

Servers MUST validate capabilities before using features:

```typescript
// Pseudocode
function validateCreateMessageRequest(
  request: CreateMessageRequest,
  clientCapabilities: ClientCapabilities
): void {
  // Check context capability
  if (request.params.includeContext &&
      request.params.includeContext !== "none") {
    if (!clientCapabilities.sampling?.context) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Client does not support includeContext parameter. ` +
        `Client must advertise sampling.context capability.`
      );
    }
  }

  // Check tools capability
  if (request.params.tools || request.params.tool_choice) {
    if (!clientCapabilities.sampling?.tools) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Client does not support tools parameter. ` +
        `Client must advertise sampling.tools capability.`
      );
    }
  }

  // tool_choice requires tools
  if (request.params.tool_choice && !request.params.tools) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `tool_choice requires tools parameter to be set`
    );
  }
}
```

#### Message Balancing

Servers MUST ensure tool calls and results are balanced:

```typescript
// Pseudocode validation
function validateMessageBalance(messages: SamplingMessage[]): void {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of messages) {
    if (message.content.type === "tool_use") {
      if (toolCallIds.has(message.content.id)) {
        throw new Error(`Duplicate tool call ID: ${message.content.id}`);
      }
      toolCallIds.add(message.content.id);
    }

    if (message.content.type === "tool_result") {
      toolResultIds.add(message.content.toolUseId);
    }
  }

  // Every tool call must have a result
  for (const callId of toolCallIds) {
    if (!toolResultIds.has(callId)) {
      throw new Error(`Tool call ${callId} has no corresponding result`);
    }
  }

  // Every result must reference a valid call
  for (const resultId of toolResultIds) {
    if (!toolCallIds.has(resultId)) {
      throw new Error(`Tool result references unknown call: ${resultId}`);
    }
  }
}
```

#### Tool Execution Loop

Servers implementing agentic loops SHOULD:

```typescript
async function agenticLoop(
  client: McpClient,
  initialMessages: SamplingMessage[],
  tools: Tool[]
): Promise<CreateMessageResult> {
  let messages = [...initialMessages];

  while (true) {
    // Request completion from LLM
    const result = await client.request(CreateMessageRequestSchema, {
      method: "sampling/createMessage",
      params: {
        messages,
        tools,
        maxTokens: 4096,
      }
    }, CreateMessageResultSchema);

    // Check if tool use is required
    if (result.stopReason === "toolUse" &&
        result.content.type === "tool_use") {

      // Add assistant message with tool call
      messages.push({
        role: "assistant",
        content: result.content
      });

      // Execute tool locally
      const toolResult = await executeToolLocally(
        result.content.name,
        result.content.input
      );

      // Add user message with tool result
      messages.push({
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: result.content.id,
          content: toolResult,
          isError: toolResult.error ? true : undefined
        }
      });

      // Continue loop
      continue;
    }

    // Completion - return final result
    return result;
  }
}
```

### 3.2 Client Requirements

#### Capability Advertisement

Clients MUST advertise capabilities accurately:

```typescript
const clientCapabilities: ClientCapabilities = {
  sampling: {
    // Advertise context support if implemented
    context: supportContextInclusion ? {} : undefined,

    // Advertise tools support if implemented
    tools: supportToolCalling ? {} : undefined,
  },
  // ... other capabilities
};
```

#### Tool Execution

Clients MUST:

1. Validate tool definitions in requests
2. Provide tools to LLM in provider-specific format
3. Handle tool calls in LLM responses
4. Return results with correct `stopReason`

Clients MAY:

1. Filter or modify tool definitions for safety
2. Request user approval before tool use
3. Implement tool execution client-side
4. Convert between provider-specific tool formats

#### Error Handling

Clients MUST return appropriate errors:

| Condition | Error Code | Message |
|-----------|-----------|---------|
| Unsupported capability used | `InvalidRequest` | "Client does not support [feature]" |
| Invalid tool definition | `InvalidParams` | "Invalid tool schema: [details]" |
| Tool execution failed | N/A | Return success with `isError: true` |
| Request refused by LLM | N/A | Return success with `stopReason: "refusal"` |

---

## 4. Backwards Compatibility

### 4.1 Compatibility Strategy

**Soft Deprecation:**
- `includeContext` is marked soft-deprecated but remains functional
- Implementations SHOULD prefer `tools` over `includeContext`
- Both MAY coexist in transition period
- `includeContext` MAY be removed in future spec version

**Version Detection:**

```typescript
function supportsToolCalling(capabilities: ClientCapabilities): boolean {
  return capabilities.sampling?.tools !== undefined;
}

function supportsContextInclusion(capabilities: ClientCapabilities): boolean {
  return capabilities.sampling?.context !== undefined;
}
```

### 4.2 Migration Path

**For Server Implementations:**

1. Check client capabilities in negotiation
2. Prefer `tools` parameter if available
3. Fall back to `includeContext` for older clients
4. Validate capabilities before sending requests

**For Client Implementations:**

1. Add `sampling.tools` capability when ready
2. Continue supporting `sampling.context` for existing servers
3. Implement tool calling according to provider's API
4. Update to handle new content types and stop reasons

### 4.3 Breaking Changes

**Type Changes:**

| Old Type | New Type | Breaking? | Migration |
|----------|----------|-----------|-----------|
| `SamplingMessage` | Split into `UserMessage` / `AssistantMessage` | Yes | Use discriminated union |
| `stopReason: "maxToken"` | `stopReason: "maxTokens"` | Yes | Support both for transition |
| Content types | Added `ToolCallContent`, `ToolResultContent` | Additive | Extend parsers |

**Validation Changes:**

- Parsers MUST handle new content types
- Message role validation is now stricter (role-specific content)
- Tool call/result balancing is required when tools used

---

## 5. Implementation Checklist

### 5.1 TypeScript SDK Changes Required

#### src/types.ts

- [ ] Add `ToolCallContentSchema` and `ToolCallContent` type
- [ ] Add `ToolResultContentSchema` and `ToolResultContent` type
- [ ] Split `SamplingMessageSchema` into `UserMessageSchema` and `AssistantMessageSchema`
- [ ] Add `ToolChoiceSchema` and `ToolChoice` type
- [ ] Update `CreateMessageRequestSchema` to include `tools` and `tool_choice`
- [ ] Update `CreateMessageResultSchema`:
  - [ ] Add new stop reason values: `"toolUse"`, `"refusal"`, `"other"`
  - [ ] Rename `"maxToken"` to `"maxTokens"` (keep both for transition)
  - [ ] Update content type to include `ToolCallContent`
  - [ ] Fix role to be `"assistant"` only
- [ ] Update `ClientCapabilitiesSchema` to include `sampling.context` and `sampling.tools`
- [ ] Add validation helpers for message balancing
- [ ] Export all new types and schemas

#### src/client/index.ts

- [ ] Add capability advertisement for `sampling.tools`
- [ ] Add request validation for tool capabilities
- [ ] Add helper methods for tool calling workflow
- [ ] Update example code / documentation comments

#### src/server/index.ts

- [ ] Add validation for client capabilities before using tools
- [ ] Add helper for building tool-enabled sampling requests
- [ ] Add validation for message balance
- [ ] Add error handling for unsupported capabilities

### 5.2 Test Requirements

#### Unit Tests

- [ ] Test `ToolCallContent` schema validation
- [ ] Test `ToolResultContent` schema validation
- [ ] Test `UserMessage` and `AssistantMessage` schemas
- [ ] Test `ToolChoice` schema validation
- [ ] Test updated `CreateMessageRequest` schema
- [ ] Test updated `CreateMessageResult` schema
- [ ] Test capability negotiation logic
- [ ] Test message balance validation
- [ ] Test error conditions:
  - [ ] Using tools without capability
  - [ ] Using context without capability
  - [ ] Unbalanced tool calls/results
  - [ ] Invalid tool choice with no tools

#### Integration Tests

- [ ] Test full agentic loop with tool calling
- [ ] Test client-server capability negotiation
- [ ] Test backwards compatibility with old clients
- [ ] Test error propagation
- [ ] Test tool execution with various content types
- [ ] Test multi-turn conversations with tools

### 5.3 Documentation Requirements

- [ ] Update API documentation for new types
- [ ] Add migration guide for existing implementations
- [ ] Add examples of agentic workflows
- [ ] Document capability negotiation
- [ ] Add troubleshooting guide for common errors
- [ ] Update changelog with breaking changes

---

## 6. Test Scenarios

### 6.1 Basic Tool Calling

**Scenario:** Client supports tools, server uses single tool

```typescript
// Client advertises capability
const clientCaps: ClientCapabilities = {
  sampling: { tools: {} }
};

// Server sends request
const request: CreateMessageRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "What's the weather in SF?" }
      }
    ],
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string" }
          },
          required: ["location"]
        }
      }
    ],
    maxTokens: 1000
  }
};

// Expected response
const response: CreateMessageResult = {
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  stopReason: "toolUse",
  content: {
    type: "tool_use",
    id: "tool_1",
    name: "get_weather",
    input: { location: "San Francisco, CA" }
  }
};
```

### 6.2 Tool Result Submission

**Scenario:** Server provides tool result in follow-up

```typescript
// Server adds tool result
const followUp: CreateMessageRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "What's the weather in SF?" }
      },
      {
        role: "assistant",
        content: {
          type: "tool_use",
          id: "tool_1",
          name: "get_weather",
          input: { location: "San Francisco, CA" }
        }
      },
      {
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: "tool_1",
          content: {
            temperature: 65,
            condition: "Partly cloudy",
            humidity: 70
          }
        }
      }
    ],
    tools: [/* same tools */],
    maxTokens: 1000
  }
};

// Expected final response
const finalResponse: CreateMessageResult = {
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  stopReason: "endTurn",
  content: {
    type: "text",
    text: "The weather in San Francisco is currently 65°F and partly cloudy with 70% humidity."
  }
};
```

### 6.3 Tool Error Handling

**Scenario:** Tool execution fails

```typescript
const errorResult: CreateMessageRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [
      /* ... previous messages ... */
      {
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: "tool_1",
          content: {
            error: "API_ERROR",
            message: "Weather service unavailable"
          },
          isError: true
        }
      }
    ],
    tools: [/* same tools */],
    maxTokens: 1000
  }
};

// LLM should handle error gracefully
const errorResponse: CreateMessageResult = {
  model: "claude-3-5-sonnet-20241022",
  role: "assistant",
  stopReason: "endTurn",
  content: {
    type: "text",
    text: "I apologize, but I'm unable to fetch the weather data right now due to a service issue. Please try again later."
  }
};
```

### 6.4 Capability Rejection

**Scenario:** Client doesn't support tools

```typescript
// Client without tools capability
const limitedClientCaps: ClientCapabilities = {
  sampling: {} // No tools property
};

// Server attempts to use tools
const request: CreateMessageRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [/* ... */],
    tools: [/* ... */],  // ERROR: Not supported
    maxTokens: 1000
  }
};

// Expected error response
// Client should return JSON-RPC error:
{
  jsonrpc: "2.0",
  id: 1,
  error: {
    code: ErrorCode.InvalidRequest,
    message: "Client does not support tools parameter. Client must advertise sampling.tools capability."
  }
}
```

### 6.5 Parallel Tool Use

**Scenario:** Model uses multiple tools in one response (if supported)

```typescript
// Note: Not all models/providers support parallel tool use
// When supported, response might contain multiple tool calls

const parallelRequest: CreateMessageRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Compare weather in SF and NYC" }
      }
    ],
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a location",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string" }
          },
          required: ["location"]
        }
      }
    ],
    tool_choice: {
      mode: "auto",
      disable_parallel_tool_use: false  // Allow parallel use
    },
    maxTokens: 1000
  }
};

// IMPLEMENTATION NOTE:
// Current spec shows single content per message.
// Parallel tool use may require:
// 1. Multiple assistant messages, OR
// 2. Array of content blocks (not in current spec), OR
// 3. Sequential tool calls in separate turns
// Clarification needed in specification.
```

### 6.6 Backwards Compatibility

**Scenario:** Old client without sampling capabilities

```typescript
// Legacy client
const legacyClientCaps: ClientCapabilities = {
  // No sampling property at all
};

// Server checks capabilities
if (!clientCaps.sampling?.tools) {
  // Fall back to alternative implementation
  // or return error if tools are required
  throw new Error("This server requires tool support");
}
```

---

## 7. Open Questions and Ambiguities

### 7.1 Specification Gaps

1. **Parallel Tool Use Implementation:**
   - How should multiple tool calls be represented in a single response?
   - Should `content` be an array of content blocks?
   - Or should each tool call be a separate assistant message?

2. **Tool Result Content Schema:**
   - Should `content` validate against `outputSchema`?
   - How should validation errors be reported?
   - What's the expected format for error content?

3. **Message Ordering:**
   - Must tool results immediately follow tool calls?
   - Can multiple tool calls be batched before results?
   - Can user messages be interleaved?

4. **Context + Tools Interaction:**
   - How do `includeContext` and `tools` interact when both present?
   - Should tools override context, or vice versa?
   - Migration strategy unclear

5. **Stop Reason Semantics:**
   - What's the difference between `"refusal"` and returning text explaining refusal?
   - When should `"other"` be used vs extending the enum?
   - Should `"toolUse"` be used even if `tool_choice.mode` was `"required"`?

### 7.2 Implementation Questions

1. **Tool Validation:**
   - Should SDK validate tool schemas before sending?
   - Should SDK validate tool inputs against schemas?
   - Who validates outputSchema compliance?

2. **Error Handling:**
   - Should tool execution errors be MCP errors or tool results with `isError: true`?
   - What error codes should be used for tool-related failures?
   - How should schema validation failures be reported?

3. **Type Safety:**
   - How to enforce role-content compatibility at compile time?
   - Should content be a discriminated union per role?
   - How to prevent `ToolCallContent` in `UserMessage`?

4. **Testing:**
   - How to test multi-model compatibility?
   - Should SDK include mock LLM for testing?
   - How to validate different provider tool formats?

### 7.3 Recommendations for Clarification

1. **Add explicit examples** for:
   - Parallel tool use (if supported)
   - Error handling patterns
   - Multi-turn conversations with mixed content

2. **Clarify validation requirements:**
   - Who validates what and when
   - Expected error responses for each validation failure
   - Schema compliance requirements

3. **Define message sequencing rules:**
   - Allowed message patterns
   - Prohibited patterns
   - Ordering requirements

4. **Document provider-specific behavior:**
   - How to handle provider-specific tool formats
   - Dealing with capability mismatches
   - Fallback strategies

---

## 8. Related Resources

### Primary Documents

- **SEP-1577 Issue:** https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1577
- **MCP Specification:** https://spec.modelcontextprotocol.io/
- **TypeScript SDK:** https://github.com/modelcontextprotocol/typescript-sdk

### Related SEPs

- **SEP-973:** Icons and metadata support (merged)
- **SEP-835:** Authorization scope management
- **SEP-1299:** Server-side authorization management
- **SEP-1502:** MCP extension specification

### Related Discussions

- **Discussion #124:** Improve sampling in the protocol
  - https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/124
- **Issue #503:** Reframe sampling for agent-to-agent communication
  - https://github.com/modelcontextprotocol/modelcontextprotocol/issues/503
- **Discussion #314:** Task semantics and multi-turn interactions
  - https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/314
- **Discussion #315:** Suggested response format proposal
  - https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/315

### External References

- **Anthropic Claude API:** Tool use documentation
- **OpenAI API:** Function calling documentation
- **JSON Schema:** https://json-schema.org/
- **RFC 9110:** HTTP Semantics

---

## 9. Implementation Timeline

### Phase 1: Type Definitions (Week 1)
- Add new content type schemas
- Update message type schemas
- Update request/result schemas
- Add capability schemas
- Write unit tests for schemas

### Phase 2: Validation (Week 1-2)
- Implement capability checking
- Implement message balance validation
- Implement error handling
- Write validation tests

### Phase 3: Client/Server Integration (Week 2)
- Update client implementation
- Update server implementation
- Add helper methods
- Write integration tests

### Phase 4: Documentation and Examples (Week 2-3)
- Update API documentation
- Write migration guide
- Create example implementations
- Write user guides

### Phase 5: Review and Polish (Week 3)
- Code review
- Documentation review
- Performance testing
- Bug fixes

---

## 10. Security Considerations

### 10.1 Tool Definition Validation

Servers SHOULD validate tool definitions from untrusted sources:
- Validate schemas are well-formed JSON Schema
- Limit tool definition size
- Sanitize tool names and descriptions
- Prevent schema injection attacks

### 10.2 Tool Execution Safety

Clients MUST implement safety measures:
- Validate tool inputs before execution
- Sandbox tool execution when possible
- Request user approval for sensitive operations
- Log all tool executions
- Implement rate limiting

### 10.3 Content Validation

Both sides SHOULD validate content:
- Check content size limits
- Validate base64 encoding for binary data
- Sanitize text content for display
- Validate JSON structure
- Prevent injection attacks

### 10.4 Capability-Based Security

Implementations MUST:
- Enforce capability checks strictly
- Reject requests using unsupported features
- Never assume capabilities without negotiation
- Log capability violations

---

## Appendix A: Current vs New Type Comparison

### A.1 SamplingMessage

**Current (pre-SEP-1577):**
```typescript
interface SamplingMessage {
  role: "user" | "assistant";
  content: TextContent | ImageContent | AudioContent;
}
```

**New (SEP-1577):**
```typescript
type SamplingMessage = UserMessage | AssistantMessage;

interface UserMessage {
  role: "user";
  content: TextContent | ImageContent | AudioContent | ToolResultContent;
}

interface AssistantMessage {
  role: "assistant";
  content: TextContent | ImageContent | AudioContent | ToolCallContent;
}
```

### A.2 CreateMessageResult

**Current (pre-SEP-1577):**
```typescript
interface CreateMessageResult {
  model: string;
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | string;
  role: "user" | "assistant";
  content: TextContent | ImageContent | AudioContent;
}
```

**New (SEP-1577):**
```typescript
interface CreateMessageResult {
  model: string;
  stopReason?: "endTurn" | "stopSequence" | "maxTokens" | "toolUse" | "refusal" | "other" | string;
  role: "assistant";  // Fixed, not union
  content: TextContent | ImageContent | AudioContent | ToolCallContent;
}
```

### A.3 ClientCapabilities

**Current (pre-SEP-1577):**
```typescript
interface ClientCapabilities {
  sampling?: object;
  // ... other capabilities
}
```

**New (SEP-1577):**
```typescript
interface ClientCapabilities {
  sampling?: {
    context?: object;
    tools?: object;
  };
  // ... other capabilities
}
```

---

## Appendix B: Complete Zod Schema Definitions

```typescript
// Content types
export const ToolCallContentSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  id: z.string(),
  input: z.object({}).passthrough(),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export const ToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.object({}).passthrough(),
  isError: z.optional(z.boolean()),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

// Message types
export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolResultContentSchema,
  ]),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,
  ]),
  _meta: z.optional(z.object({}).passthrough()),
}).passthrough();

export const SamplingMessageSchema = z.discriminatedUnion("role", [
  UserMessageSchema,
  AssistantMessageSchema,
]);

// Tool choice
export const ToolChoiceSchema = z.object({
  mode: z.optional(z.enum(["auto", "required"])),
  disable_parallel_tool_use: z.optional(z.boolean()),
}).passthrough();

// Updated request
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
    tools: z.optional(z.array(ToolSchema)),
    tool_choice: z.optional(ToolChoiceSchema),
  }),
});

// Updated result
export const CreateMessageResultSchema = ResultSchema.extend({
  model: z.string(),
  stopReason: z.optional(
    z.enum(["endTurn", "stopSequence", "maxTokens", "toolUse", "refusal", "other"]).or(z.string())
  ),
  role: z.literal("assistant"),
  content: z.discriminatedUnion("type", [
    TextContentSchema,
    ImageContentSchema,
    AudioContentSchema,
    ToolCallContentSchema,
  ]),
});

// Updated capabilities
export const ClientCapabilitiesSchema = z.object({
  sampling: z.optional(z.object({
    context: z.optional(z.object({}).passthrough()),
    tools: z.optional(z.object({}).passthrough()),
  }).passthrough()),
  // ... other capabilities
}).passthrough();
```

---

## Appendix C: TypeScript Type Definitions

```typescript
// Inferred types
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;
export type ToolResultContent = z.infer<typeof ToolResultContentSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type SamplingMessage = z.infer<typeof SamplingMessageSchema>;
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
export type CreateMessageResult = z.infer<typeof CreateMessageResultSchema>;
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;
```

---

## Document Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-10-01 | Research Agent | Initial comprehensive analysis |

---

**END OF DOCUMENT**
