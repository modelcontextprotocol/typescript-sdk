# Test Review: toolLoopSampling.test.ts

## Executive Summary

The test file `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/toolLoopSampling.test.ts` is **ready to commit with minor improvements recommended**. The tests are well-structured, provide good coverage of the tool loop functionality, and follow project conventions. However, there are opportunities for simplification and improved maintainability.

## Test Coverage Analysis

### Covered Scenarios ✓

1. **Happy Path**: Tool loop with sequential ripgrep and read operations (lines 57-165)
2. **Error Handling**:
   - Path validation errors (lines 167-251)
   - Invalid tool names (lines 253-331)
   - Malformed tool inputs (lines 333-413)
3. **Edge Cases**:
   - Maximum iteration limit enforcement (lines 415-470)

### Coverage Assessment

**Score: 8/10**

**Strengths:**
- Tests the complete tool loop flow from initial query to final answer
- Validates error propagation and handling at multiple levels
- Confirms iteration limit protection against infinite loops
- Tests input validation (both tool name and tool parameters)

**Gaps:**
- No test for successful multi-iteration loops (e.g., ripgrep → read → ripgrep again → answer)
- Missing test for stopReason variants beyond "toolUse" and "endTurn"
- No explicit test for tool result error handling when tool execution fails but returns gracefully
- No test for empty/edge case responses from ripgrep (e.g., "No matches found")

## Code Quality Assessment

### Structure & Organization

**Score: 9/10**

- Consistent test structure across all test cases
- Good use of `beforeEach` and `afterEach` for setup/teardown
- Clear test names that describe the scenario being tested
- Proper Jest timeout configuration for integration tests

### Best Practices Adherence

**Comparison with project patterns:**

| Pattern | toolLoopSampling.test.ts | server/index.test.ts | client/index.test.ts | Assessment |
|---------|--------------------------|----------------------|----------------------|------------|
| Transport management | Uses StdioClientTransport | Uses InMemoryTransport | Uses mock Transport | ✓ Appropriate for integration |
| Client/Server setup | Creates real client+server | Creates real client+server | Uses mocks | ✓ Correct pattern |
| Handler setup | Uses setRequestHandler | Uses setRequestHandler | Uses setRequestHandler | ✓ Consistent |
| Assertions | Uses expect().toBe/toContain | Uses expect().toBe/toEqual | Uses expect().toBe | ✓ Standard Jest |
| Error testing | Tests via result content | Uses rejects.toThrow | Uses rejects.toThrow | ⚠️ Could be more explicit |

**Observations:**
- **Positive**: The test properly spawns the actual server using `npx tsx`, making it a true integration test
- **Positive**: Uses `resolve(__dirname, ...)` for reliable path resolution
- **Concern**: Heavy reliance on `console.error` output for debugging (lines 71-73, etc.)
- **Concern**: Sampling handler complexity increases with each test case

## Duplication Analysis

### Identified Duplication

1. **Client/Transport Setup** (repeated in every `beforeEach`):
   ```typescript
   // Lines 25-51 - repeated setup code
   client = new Client(...)
   transport = new StdioClientTransport(...)
   ```

2. **Sampling Handler Pattern** (repeated 5 times):
   ```typescript
   // Lines 62-134, 171-229, 258-312, 338-394, 419-439
   client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
     samplingCallCount++;
     const messages = request.params.messages;
     const lastMessage = messages[messages.length - 1];
     // ... different logic per test
   })
   ```

3. **Connection and Tool Call** (repeated 5 times):
   ```typescript
   // Lines 136-151, 231-245, 314-327, 396-409, 442-456
   await client.connect(transport);
   const result = await client.request({ method: "tools/call", ... })
   ```

### Duplication Impact

**Score: 6/10** (significant duplication, but manageable)

## Simplification Opportunities

### High Priority

1. **Extract Helper Function for Sampling Handler Setup**
   ```typescript
   // Proposed helper
   function createMockSamplingHandler(responses: Array<ToolCallContent | TextContent>) {
     let callIndex = 0;
     return async (request: CreateMessageRequest): Promise<CreateMessageResult> => {
       const response = responses[callIndex];
       callIndex++;
       if (!response) {
         throw new Error(`Unexpected sampling call count: ${callIndex}`);
       }
       return {
         model: "test-model",
         role: "assistant",
         content: response,
         stopReason: response.type === "tool_use" ? "toolUse" : "endTurn",
       };
     };
   }
   ```
   **Benefit**: Reduce 150+ lines of duplicated handler setup code

2. **Extract Helper for Common Test Flow**
   ```typescript
   // Proposed helper
   async function executeFileSearchTest(
     client: Client,
     transport: StdioClientTransport,
     query: string,
     expectedSamplingCalls: number
   ) {
     await client.connect(transport);
     const result = await client.request(
       { method: "tools/call", params: { name: "fileSearch", arguments: { query } } },
       CallToolResultSchema
     );
     return { result, samplingCallCount: /* tracked value */ };
   }
   ```
   **Benefit**: Reduce boilerplate in each test

3. **Simplify Error Assertions**
   ```typescript
   // Current (lines 199-210):
   expect(lastMessage.content.type).toBe("tool_result");
   if (lastMessage.content.type === "tool_result") {
     const content = lastMessage.content.content as Record<string, unknown>;
     expect(content.error).toBeDefined();
     expect(typeof content.error === "string" && content.error.includes("...")).toBe(true);
   }

   // Proposed:
   expectToolResultError(lastMessage, "outside the current directory");
   ```
   **Benefit**: Improve readability and maintainability

### Medium Priority

4. **Remove Verbose Console Logging**
   - Lines 71-73: Console.error statements should use a debug flag or be removed
   - These logs are helpful during development but clutter test output

5. **Consolidate Type Assertions**
   - Lines 159-161, 200-210, 284-295: Repeated type narrowing patterns
   - Create a helper: `assertTextContent(content)` or use type guards

### Low Priority

6. **Use Test.each for Similar Tests**
   - Tests for "invalid tool names" and "malformed tool inputs" follow similar patterns
   - Could be parameterized to reduce code

## Clarity Assessment

**Score: 8/10**

### Strengths
- Test names clearly describe what's being tested
- Comments explain the test scenario (lines 2-6, 57, etc.)
- Logical flow is easy to follow
- Good use of descriptive variable names

### Areas for Improvement
1. **Overly Complex Inline Handlers**: The sampling handlers contain significant logic that makes tests harder to understand at a glance
2. **Mixed Concerns**: Tests verify both the sampling call count AND the result content, which could be split
3. **Implicit Behavior**: The interaction between samplingCallCount and handler logic requires mental tracking

## Comparison with Project Test Patterns

### server/index.test.ts Patterns
- ✓ Uses descriptive test names
- ✓ Groups related tests with `describe` blocks
- ✓ Uses `beforeEach`/`afterEach` consistently
- ✓ Tests both success and error cases
- ⚠️ toolLoopSampling uses more complex integration setup (spawning process)

### client/index.test.ts Patterns
- ✓ Similar assertion patterns
- ✓ Uses `expect().toBe()`, `expect().toContain()`
- ✓ Tests timeout and cancellation scenarios
- ⚠️ toolLoopSampling has more verbose test bodies

### protocol.test.ts Patterns
- ✓ Good use of jest.fn() for mocking
- ✓ Clean setup/teardown
- ✓ Focused test cases
- ⚠️ toolLoopSampling could benefit from similar spy usage

## Recommendations

### Must Fix (Before Commit)
None - the tests are functional and pass.

### Should Fix (High Value)
1. **Extract sampling handler helper** - Reduces duplication by ~40%
2. **Add helper for error content assertions** - Improves readability
3. **Remove or gate console.error debug statements** - Cleaner test output

### Nice to Have (Future Improvements)
1. Add test for successful multi-step tool loop (ripgrep → read → ripgrep → answer)
2. Add test for edge cases in tool results (empty results, no matches)
3. Consider parameterized tests for error scenarios
4. Add JSDoc comments to explain the test strategy

## Verdict

**Status: READY TO COMMIT AS-IS**

The tests are well-designed, follow project conventions, and provide solid coverage of the tool loop sampling functionality. While there are opportunities for refactoring to reduce duplication and improve clarity, the current implementation is:

- ✓ Functional and passing
- ✓ Covers main scenarios adequately
- ✓ Follows TypeScript and Jest best practices
- ✓ Provides good error coverage
- ✓ Tests important edge cases (iteration limit, validation errors)

**Recommended Action:**
1. Commit the tests as-is to establish baseline coverage
2. Create a follow-up task to implement the suggested refactorings
3. Consider adding the recommended test cases for multi-step loops in a future iteration

## Files Analyzed

- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/toolLoopSampling.test.ts` (main test file)
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/toolLoopSampling.ts` (implementation)
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/server/index.test.ts` (reference patterns)
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/client/index.test.ts` (reference patterns)
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/shared/protocol.test.ts` (reference patterns)
- `/Users/ochafik/code/modelcontextprotocol-typescript-sdk/src/examples/server/demoInMemoryOAuthProvider.test.ts` (reference patterns)
