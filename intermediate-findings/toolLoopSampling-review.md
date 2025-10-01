# Tool Loop Sampling Review

## Summary

The `toolLoopSampling.ts` file implements a sophisticated MCP server that demonstrates a tool loop pattern using sampling. The server exposes a `fileSearch` tool that uses an LLM (via MCP sampling) with locally-defined `ripgrep` and `read` tools to intelligently search and read files in the current directory.

### Architecture

The implementation follows a proxy pattern where:
1. Client calls the `fileSearch` tool with a natural language query
2. The server runs a tool loop that:
   - Sends the query to an LLM via `server.createMessage()`
   - The LLM decides to use `ripgrep` or `read` tools (defined locally)
   - The server executes these tools locally
   - Results are fed back to the LLM
   - Process repeats until the LLM provides a final answer
3. The final answer is returned to the client

---

## What's Done Well

### 1. **Clear Separation of Concerns**
- Path safety logic is isolated in `ensureSafePath()`
- Tool execution is separated from tool loop orchestration
- Local tool definitions are cleanly defined in `LOCAL_TOOLS` constant

### 2. **Proper Error Handling**
- Path validation with security checks
- Graceful handling of ripgrep exit codes (0 and 1 are both success)
- Error handling in tool execution functions returns structured error objects
- Top-level try-catch in the `fileSearch` handler

### 3. **Good Documentation**
- Comprehensive file-level comments explaining the purpose
- Clear usage instructions
- Function-level JSDoc comments

### 4. **Security Considerations**
- Path canonicalization to prevent directory traversal attacks
- Working directory constraint enforcement

### 5. **Tool Loop Pattern**
- Implements a proper agentic loop with iteration limits
- Correctly handles tool use responses
- Properly constructs message history

---

## Issues Found

### 1. **Critical: Incorrect Content Type Handling** ⚠️

**Location:** Lines 214-215

```typescript
if (response.stopReason === "toolUse" && response.content.type === "tool_use") {
  const toolCall = response.content as ToolCallContent;
```

**Problem:** According to the MCP protocol types (lines 1361-1366 in `types.ts`), `CreateMessageResult.content` is a **discriminated union**, not an array. The code correctly handles this as a single content block. However, the condition checks both `stopReason` and `content.type`, which is redundant.

**Impact:** This works but is redundant. When `stopReason === "toolUse"`, the content type is guaranteed to be `"tool_use"`.

**Fix:** Simplify the condition:
```typescript
if (response.stopReason === "toolUse") {
  const toolCall = response.content as ToolCallContent;
```

### 2. **Type Safety Issue: Message Content Structure** ⚠️

**Location:** Lines 183-191, 208-211

```typescript
const messages: SamplingMessage[] = [
  {
    role: "user",
    content: {
      type: "text",
      text: initialQuery,
    },
  },
];
```

**Problem:** According to `SamplingMessageSchema` (lines 1285-1288 in `types.ts`), the schema uses a discriminated union. The code structure is correct, but TypeScript may not enforce this properly without explicit type annotations.

**Impact:** Currently works, but could lead to type errors if the content structure changes.

**Fix:** Add explicit type annotation:
```typescript
const messages: SamplingMessage[] = [
  {
    role: "user",
    content: {
      type: "text",
      text: initialQuery,
    } as TextContent,
  } as UserMessage,
];
```

### 3. **Edge Case: Empty Content Block** ⚠️

**Location:** Lines 244-247

```typescript
// LLM provided final answer
if (response.content.type === "text") {
  return response.content.text;
}
```

**Problem:** The code assumes that if the content type is "text", it has a valid `text` field. While this should always be true according to the protocol, there's no null/empty check.

**Impact:** Could potentially return an empty string if the LLM returns empty text content.

**Fix:** Add validation:
```typescript
if (response.content.type === "text") {
  const text = response.content.text;
  if (!text) {
    throw new Error("LLM returned empty text content");
  }
  return text;
}
```

### 4. **Potential Race Condition: System Prompt Injection**

**Location:** Lines 283-290

```typescript
const systemPrompt =
  "You are a helpful assistant that searches through files to answer questions. " +
  "You have access to ripgrep (for searching) and read (for reading file contents). " +
  "Use ripgrep to find relevant files, then read them to provide accurate answers. " +
  "All paths are relative to the current working directory. " +
  "Be concise and focus on providing the most relevant information.";

const fullQuery = `${systemPrompt}\n\nUser query: ${query}`;
```

**Problem:** The system prompt is injected into the user message rather than using the `systemPrompt` parameter of `createMessage()`. This is not following MCP best practices.

**Impact:**
- The LLM sees this as part of the user message, not as a system instruction
- Less effective instruction following
- Deviates from the protocol design

**Fix:** Use the proper parameter:
```typescript
const response: CreateMessageResult = await server.server.createMessage({
  messages,
  systemPrompt: "You are a helpful assistant that searches through files...",
  maxTokens: 4000,
  tools: LOCAL_TOOLS,
  tool_choice: { mode: "auto" },
});
```

And remove the system prompt from the initial query:
```typescript
const messages: SamplingMessage[] = [
  {
    role: "user",
    content: {
      type: "text",
      text: initialQuery,  // Just the query, not the system prompt
    },
  },
];
```

### 5. **Missing: Tool Input Validation**

**Location:** Lines 157-173

```typescript
async function executeLocalTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "ripgrep": {
      const { pattern, path } = toolInput as { pattern: string; path: string };
      return await executeRipgrep(pattern, path);
    }
    case "read": {
      const { path } = toolInput as { path: string };
      return await executeRead(path);
    }
```

**Problem:** No validation that the input actually contains the required fields or that they are strings.

**Impact:** Could crash with unhelpful errors if the LLM provides malformed input.

**Fix:** Add validation:
```typescript
case "ripgrep": {
  if (typeof toolInput.pattern !== 'string' || typeof toolInput.path !== 'string') {
    return { error: 'Invalid input: pattern and path must be strings' };
  }
  const { pattern, path } = toolInput as { pattern: string; path: string };
  return await executeRipgrep(pattern, path);
}
```

### 6. **Inconsistent Logging**

**Location:** Lines 217-228, 281, 294

**Problem:** Some operations log detailed information, others don't. The logging uses `console.error` inconsistently.

**Impact:** Makes debugging harder; inconsistent user experience.

**Fix:** Add consistent logging at key points:
- Before and after LLM calls
- Tool execution start/end
- Error conditions

### 7. **Tool Result Structure Mismatch**

**Location:** Lines 230-238

```typescript
// Add tool result to message history
messages.push({
  role: "user",
  content: {
    type: "tool_result",
    toolUseId: toolCall.id,
    content: toolResult,
  },
});
```

**Problem:** According to `ToolResultContentSchema` (lines 873-893 in `types.ts`), the `content` field should be a passthrough object. The current implementation passes `toolResult` which is `Record<string, unknown>`, which is correct. However, the tool execution functions return objects with `{ output?: string; error?: string }` or `{ content?: string; error?: string }`, which is inconsistent.

**Impact:** This works but creates an inconsistent structure for tool results.

**Fix:** Standardize tool result format:
```typescript
interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}
```

---

## Suggested Improvements

### 1. **Use Zod for Input Validation**

The code already imports `z` from zod but only uses it for the tool registration. Consider using Zod schemas to validate tool inputs:

```typescript
const RipgrepInputSchema = z.object({
  pattern: z.string(),
  path: z.string(),
});

const ReadInputSchema = z.object({
  path: z.string(),
});

async function executeLocalTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    switch (toolName) {
      case "ripgrep": {
        const validated = RipgrepInputSchema.parse(toolInput);
        return await executeRipgrep(validated.pattern, validated.path);
      }
      case "read": {
        const validated = ReadInputSchema.parse(toolInput);
        return await executeRead(validated.path);
      }
      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Validation error",
    };
  }
}
```

### 2. **Add Configurable Parameters**

Consider making some hardcoded values configurable:

```typescript
interface ToolLoopConfig {
  maxIterations?: number;
  maxTokens?: number;
  workingDirectory?: string;
  ripgrepMaxCount?: number;
}

async function runToolLoop(
  server: McpServer,
  initialQuery: string,
  config: ToolLoopConfig = {}
): Promise<string> {
  const MAX_ITERATIONS = config.maxIterations ?? 10;
  const maxTokens = config.maxTokens ?? 4000;
  // ...
}
```

### 3. **Improve Error Messages**

Currently, tool errors are opaque. Consider adding more context:

```typescript
return {
  error: `Failed to read file '${inputPath}': ${error.message}`,
  errorCode: 'FILE_READ_ERROR',
  filePath: inputPath,
};
```

### 4. **Add Tool Execution Timeout**

Long-running ripgrep searches could hang. Consider adding timeouts:

```typescript
const TOOL_EXECUTION_TIMEOUT = 30000; // 30 seconds

async function executeRipgrep(
  pattern: string,
  path: string
): Promise<{ output?: string; error?: string }> {
  return Promise.race([
    actualRipgrepExecution(pattern, path),
    new Promise<{ error: string }>((resolve) =>
      setTimeout(
        () => resolve({ error: 'Tool execution timeout' }),
        TOOL_EXECUTION_TIMEOUT
      )
    ),
  ]);
}
```

### 5. **Better Comparison with Existing Examples**

Compared to `toolWithSampleServer.ts`:
- ✅ **More sophisticated**: Implements a full agentic loop vs simple one-shot sampling
- ✅ **Better demonstrates tool calling**: Shows recursive tool use
- ⚠️ **More complex**: Could be harder for users to understand

Compared to `backfillSampling.ts`:
- ✅ **Simpler scope**: Focused on server-side tool loop vs full proxy
- ✅ **Better demonstrates local tools**: Shows how to define and execute tools locally
- ✅ **More practical example**: Real-world use case (file search)

### 6. **Consider Using `tool_choice: { mode: "required" }` Initially**

For the first iteration, you might want to ensure the LLM uses a tool:

```typescript
const response: CreateMessageResult = await server.server.createMessage({
  messages,
  maxTokens: 4000,
  tools: LOCAL_TOOLS,
  tool_choice: iteration === 1 ? { mode: "required" } : { mode: "auto" },
});
```

This ensures the LLM doesn't try to answer without searching first.

### 7. **Add Debug Mode**

```typescript
const DEBUG = process.env.DEBUG === 'true';

function debug(...args: unknown[]) {
  if (DEBUG) {
    console.error('[toolLoop DEBUG]', ...args);
  }
}
```

---

## Path Safety Analysis

The path canonicalization logic is **mostly correct** but has a subtle issue:

```typescript
function ensureSafePath(inputPath: string): string {
  const resolved = resolve(CWD, inputPath);
  const rel = relative(CWD, resolved);

  // Check if the path escapes CWD (starts with .. or is absolute outside CWD)
  if (rel.startsWith("..") || resolve(CWD, rel) !== resolved) {
    throw new Error(`Path "${inputPath}" is outside the current directory`);
  }

  return resolved;
}
```

**Issue:** The second condition `resolve(CWD, rel) !== resolved` is always false if the first condition is false, making it redundant.

**Better approach:**

```typescript
function ensureSafePath(inputPath: string): string {
  const resolved = resolve(CWD, inputPath);
  const rel = relative(CWD, resolved);

  // Check if the path escapes CWD
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${inputPath}" is outside the current directory`);
  }

  return resolved;
}
```

**Edge cases to consider:**
- Symlinks could bypass this check (consider using `realpath`)
- Windows paths with drive letters
- UNC paths on Windows

---

## Best Practices Compliance

### TypeScript Best Practices
- ✅ Uses strict type checking
- ✅ Explicit return types on functions
- ⚠️ Could use more type guards and validation
- ✅ Good use of const and let
- ✅ Proper async/await usage

### MCP SDK Best Practices
- ⚠️ **System prompt should use `systemPrompt` parameter, not be in user message**
- ✅ Proper message history management
- ✅ Correct tool result format
- ✅ Proper use of `createMessage()` API
- ✅ Good tool schema definitions

### Error Handling
- ✅ Try-catch blocks in appropriate places
- ✅ Structured error objects
- ⚠️ Could benefit from custom error types
- ⚠️ Some error messages could be more descriptive

### Code Quality
- ✅ Well-structured and readable
- ✅ Good function decomposition
- ✅ Appropriate use of constants
- ⚠️ Could benefit from more validation
- ⚠️ Some minor type safety improvements needed

---

## Recommendations

### Priority 1 (Must Fix Before Commit)

1. **Fix system prompt handling** - Use the `systemPrompt` parameter in `createMessage()` instead of prepending to user query
2. **Add input validation** - Validate tool inputs before execution
3. **Simplify redundant conditions** - Remove redundant check on line 214

### Priority 2 (Should Fix)

1. **Add empty content validation** - Check for empty text responses
2. **Improve path safety** - Consider symlink handling
3. **Standardize tool result format** - Use consistent structure for all tool results
4. **Add better logging** - Consistent, structured logging throughout

### Priority 3 (Nice to Have)

1. **Add configuration options** - Make hardcoded values configurable
2. **Add timeouts** - Prevent hung tool executions
3. **Add debug mode** - Better debugging experience
4. **Consider using `tool_choice: required` initially** - Ensure LLM searches before answering

---

## Code Quality Assessment

| Aspect | Rating | Notes |
|--------|--------|-------|
| Correctness | 8/10 | Works but has minor issues with system prompt handling |
| Security | 8/10 | Good path validation but could handle symlinks |
| Error Handling | 7/10 | Good structure but needs more validation |
| Type Safety | 7/10 | Good but could be stricter with type guards |
| Readability | 9/10 | Well-documented and structured |
| Best Practices | 7/10 | Good but system prompt handling needs fix |
| **Overall** | **7.5/10** | Good quality, needs minor fixes before commit |

---

## Verdict

**Status: Needs Minor Changes Before Commit**

The code demonstrates a sophisticated understanding of the MCP sampling API and implements a useful, practical example. However, there are a few issues that should be addressed:

1. **Must fix:** System prompt handling (use `systemPrompt` parameter)
2. **Should fix:** Add input validation
3. **Should fix:** Simplify redundant conditions

Once these issues are addressed, this will be an excellent example of MCP tool loop patterns and should be committed.

---

## Testing Recommendations

Before committing, test the following scenarios:

1. **Happy path**: Query that requires multiple tool calls
2. **Edge cases**:
   - Empty query
   - Path traversal attempts (`../`, `../../`, etc.)
   - Non-existent files
   - Very large search results
   - Binary files
3. **Error conditions**:
   - Malformed tool inputs from LLM
   - ripgrep not installed
   - Permission denied errors
   - Max iterations exceeded
4. **Security**:
   - Symlink handling
   - Absolute paths
   - Special characters in paths

Consider adding a unit test file (`toolLoopSampling.test.ts`) to cover these scenarios.
