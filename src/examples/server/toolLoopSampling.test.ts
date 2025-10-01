/**
 * Tests for toolLoopSampling.ts
 *
 * These tests verify that the fileSearch tool correctly implements a tool loop
 * by simulating an LLM that makes ripgrep and read tool calls.
 */

import { Client } from "../../client/index.js";
import { StdioClientTransport } from "../../client/stdio.js";
import {
  CreateMessageRequestSchema,
  CreateMessageResult,
  CallToolResultSchema,
  ToolCallContent,
  SamplingMessage,
} from "../../types.js";
import { resolve } from "node:path";

describe("toolLoopSampling server", () => {
  jest.setTimeout(30000); // 30 second timeout for integration tests

  let client: Client;
  let transport: StdioClientTransport;

  beforeEach(() => {
    // Create client with sampling capability
    client = new Client(
      {
        name: "test-client",
        version: "1.0.0",
      },
      {
        capabilities: {
          sampling: {
            tools: {}, // Indicate we support tool calling in sampling
          },
        },
      }
    );

    // Create transport that spawns the toolLoopSampling server
    transport = new StdioClientTransport({
      command: "npx",
      args: [
        "-y",
        "--silent",
        "tsx",
        resolve(__dirname, "toolLoopSampling.ts"),
      ],
    });
  });

  afterEach(async () => {
    await transport.close();
  });

  test("should handle a tool loop with ripgrep and read", async () => {
    // Track sampling request count to simulate different LLM responses
    let samplingCallCount = 0;

    // Set up sampling handler that simulates an LLM
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request): Promise<CreateMessageResult> => {
        samplingCallCount++;

        // Extract the last message to understand context
        const messages = request.params.messages;
        const lastMessage = messages[messages.length - 1];

        // Helper to get content as array
        const getContentArray = (content: any) => Array.isArray(content) ? content : [content];
        const lastContent = getContentArray(lastMessage.content)[0];

        console.error(
          `[test] Sampling call ${samplingCallCount}, messages: ${messages.length}, last message type: ${lastContent.type}`
        );

        // First call: Return tool_use for ripgrep
        if (samplingCallCount === 1) {
          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "tool_use",
              id: "call_1",
              name: "ripgrep",
              input: {
                pattern: "McpServer",
                path: "src",
              },
            } as ToolCallContent,
            stopReason: "toolUse",
          };
        }

        // Second call: After getting ripgrep results, return tool_use for read
        if (samplingCallCount === 2) {
          // Verify we got a tool result
          expect(lastContent.type).toBe("tool_result");

          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "tool_use",
              id: "call_2",
              name: "read",
              input: {
                path: "src/server/mcp.ts",
              },
            } as ToolCallContent,
            stopReason: "toolUse",
          };
        }

        // Third call: After getting read results, return final answer
        if (samplingCallCount === 3) {
          // Verify we got another tool result
          expect(lastContent.type).toBe("tool_result");

          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "text",
              text: "I found the McpServer class in src/server/mcp.ts. It's the main server class for MCP.",
            },
            stopReason: "endTurn",
          };
        }

        // Should not reach here
        throw new Error(
          `Unexpected sampling call count: ${samplingCallCount}`
        );
      }
    );

    // Connect client to server
    await client.connect(transport);

    // Call the fileSearch tool
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "fileSearch",
          arguments: {
            query: "Find the McpServer class definition",
          },
        },
      },
      CallToolResultSchema
    );

    // Verify the result
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe("text");

    // Verify we got the expected response
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain("McpServer");
    }

    // Verify we made exactly 3 sampling calls (tool loop worked correctly)
    expect(samplingCallCount).toBe(3);
  });

  test("should handle errors in tool execution", async () => {
    let samplingCallCount = 0;

    // Set up sampling handler that requests an invalid path
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request): Promise<CreateMessageResult> => {
        samplingCallCount++;

        const messages = request.params.messages;
        const lastMessage = messages[messages.length - 1];

        // First call: Return tool_use for ripgrep with path outside CWD
        if (samplingCallCount === 1) {
          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "tool_use",
              id: "call_1",
              name: "ripgrep",
              input: {
                pattern: "test",
                path: "../../etc/passwd", // Try to escape CWD
              },
            } as ToolCallContent,
            stopReason: "toolUse",
          };
        }

        // Second call: Should receive error in tool result
        if (samplingCallCount === 2) {
          const getContentArray = (content: any) => Array.isArray(content) ? content : [content];
          const lastContent = getContentArray(lastMessage.content)[0];
          expect(lastContent.type).toBe("tool_result");
          if (lastContent.type === "tool_result") {
            // Verify error is present in tool result
            const content = lastContent.content as Record<
              string,
              unknown
            >;
            expect(content.error).toBeDefined();
            expect(
              typeof content.error === "string" &&
                content.error.includes("outside the current directory")
            ).toBe(true);
          }

          // Return final answer acknowledging the error
          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "text",
              text: "I encountered an error: the path is outside the current directory.",
            },
            stopReason: "endTurn",
          };
        }

        throw new Error(
          `Unexpected sampling call count: ${samplingCallCount}`
        );
      }
    );

    await client.connect(transport);

    // Call the fileSearch tool
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "fileSearch",
          arguments: {
            query: "Search outside current directory",
          },
        },
      },
      CallToolResultSchema
    );

    // Verify we got a response (even though there was an error)
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe("text");
  });

  test("should handle invalid tool names", async () => {
    let samplingCallCount = 0;

    // Set up sampling handler that requests an unknown tool
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request): Promise<CreateMessageResult> => {
        samplingCallCount++;

        const messages = request.params.messages;
        const lastMessage = messages[messages.length - 1];

        // First call: Return tool_use for unknown tool
        if (samplingCallCount === 1) {
          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "tool_use",
              id: "call_1",
              name: "unknown_tool",
              input: {
                foo: "bar",
              },
            } as ToolCallContent,
            stopReason: "toolUse",
          };
        }

        // Second call: Should receive error in tool result
        if (samplingCallCount === 2) {
          const getContentArray = (content: any) => Array.isArray(content) ? content : [content];
          const lastContent = getContentArray(lastMessage.content)[0];
          expect(lastContent.type).toBe("tool_result");
          if (lastContent.type === "tool_result") {
            const content = lastContent.content as Record<
              string,
              unknown
            >;
            expect(content.error).toBeDefined();
            expect(
              typeof content.error === "string" &&
                content.error.includes("Unknown tool")
            ).toBe(true);
          }

          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "text",
              text: "The requested tool does not exist.",
            },
            stopReason: "endTurn",
          };
        }

        throw new Error(
          `Unexpected sampling call count: ${samplingCallCount}`
        );
      }
    );

    await client.connect(transport);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "fileSearch",
          arguments: {
            query: "Use unknown tool",
          },
        },
      },
      CallToolResultSchema
    );

    expect(result.content).toBeDefined();
    expect(samplingCallCount).toBe(2);
  });

  test("should handle malformed tool inputs", async () => {
    let samplingCallCount = 0;

    // Set up sampling handler that sends malformed input
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request): Promise<CreateMessageResult> => {
        samplingCallCount++;

        const messages = request.params.messages;
        const lastMessage = messages[messages.length - 1];

        // First call: Return tool_use with missing required fields
        if (samplingCallCount === 1) {
          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "tool_use",
              id: "call_1",
              name: "ripgrep",
              input: {
                // Missing 'pattern' and 'path' required fields
                foo: "bar",
              },
            } as ToolCallContent,
            stopReason: "toolUse",
          };
        }

        // Second call: Should receive validation error
        if (samplingCallCount === 2) {
          const getContentArray = (content: any) => Array.isArray(content) ? content : [content];
          const lastContent = getContentArray(lastMessage.content)[0];
          expect(lastContent.type).toBe("tool_result");
          if (lastContent.type === "tool_result") {
            const content = lastContent.content as Record<
              string,
              unknown
            >;
            expect(content.error).toBeDefined();
            // Verify it's a validation error
            expect(
              typeof content.error === "string" &&
                content.error.includes("Invalid input")
            ).toBe(true);
          }

          return {
            model: "test-model",
            role: "assistant",
            content: {
              type: "text",
              text: "I provided invalid input to the tool.",
            },
            stopReason: "endTurn",
          };
        }

        throw new Error(
          `Unexpected sampling call count: ${samplingCallCount}`
        );
      }
    );

    await client.connect(transport);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "fileSearch",
          arguments: {
            query: "Test malformed input",
          },
        },
      },
      CallToolResultSchema
    );

    expect(result.content).toBeDefined();
    expect(samplingCallCount).toBe(2);
  });

  test("should respect maximum iteration limit", async () => {
    let samplingCallCount = 0;

    // Set up sampling handler that keeps requesting tools indefinitely
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request): Promise<CreateMessageResult> => {
        samplingCallCount++;

        // Always return tool calls (never final answer)
        return {
          model: "test-model",
          role: "assistant",
          content: {
            type: "tool_use",
            id: `call_${samplingCallCount}`,
            name: "ripgrep",
            input: {
              pattern: "test",
              path: "src",
            },
          } as ToolCallContent,
          stopReason: "toolUse",
        };
      }
    );

    await client.connect(transport);

    // Call fileSearch with infinite loop scenario
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "fileSearch",
          arguments: {
            query: "Infinite loop test",
          },
        },
      },
      CallToolResultSchema
    );

    // Verify we got an error response (not a throw)
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe("text");

    // Verify the error message mentions the iteration limit
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toContain("Tool loop exceeded maximum iterations");
    }

    // Verify we hit the iteration limit (10 iterations as defined in toolLoopSampling.ts)
    expect(samplingCallCount).toBe(10);
  });
});
