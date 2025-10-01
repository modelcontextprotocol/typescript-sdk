/*
  This example demonstrates a tool loop using MCP sampling with locally defined tools.

  It exposes a "fileSearch" tool that uses an LLM with ripgrep and read capabilities
  to intelligently search and read files in the current directory.

  Usage:
    npx -y --silent tsx src/examples/server/toolLoopSampling.ts

  Then connect with an MCP client and call the "fileSearch" tool with a query like:
    "Find all TypeScript files that export a Server class"
*/

import { McpServer } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type {
  SamplingMessage,
  Tool,
  ToolCallContent,
  CreateMessageResult,
} from "../../types.js";

const CWD = process.cwd();

/**
 * Zod schemas for validating tool inputs
 */
const RipgrepInputSchema = z.object({
  pattern: z.string(),
  path: z.string(),
});

const ReadInputSchema = z.object({
  path: z.string(),
});

/**
 * Ensures a path is canonical and within the current working directory.
 * Throws an error if the path attempts to escape CWD.
 */
function ensureSafePath(inputPath: string): string {
  const resolved = resolve(CWD, inputPath);
  const rel = relative(CWD, resolved);

  // Check if the path escapes CWD (starts with .. or is absolute outside CWD)
  if (rel.startsWith("..") || resolve(CWD, rel) !== resolved) {
    throw new Error(`Path "${inputPath}" is outside the current directory`);
  }

  return resolved;
}

/**
 * Executes ripgrep to search for a pattern in files.
 * Returns search results as a string.
 */
async function executeRipgrep(
  pattern: string,
  path: string
): Promise<{ output?: string; error?: string }> {
  try {
    const safePath = ensureSafePath(path);

    return new Promise((resolve) => {
      const rg = spawn("rg", [
        "--json",
        "--max-count", "50",
        "--",
        pattern,
        safePath,
      ]);

      let stdout = "";
      let stderr = "";

      rg.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      rg.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      rg.on("close", (code) => {
        if (code === 0 || code === 1) {
          // code 1 means no matches, which is fine
          resolve({ output: stdout || "No matches found" });
        } else {
          resolve({ error: stderr || `ripgrep exited with code ${code}` });
        }
      });

      rg.on("error", (err) => {
        resolve({ error: `Failed to execute ripgrep: ${err.message}` });
      });
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Reads a file from the filesystem.
 * Returns file contents as a string.
 */
async function executeRead(
  path: string
): Promise<{ content?: string; error?: string }> {
  try {
    const safePath = ensureSafePath(path);
    const content = await readFile(safePath, "utf-8");
    return { content };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Defines the local tools available to the LLM during sampling.
 */
const LOCAL_TOOLS: Tool[] = [
  {
    name: "ripgrep",
    description:
      "Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The regex pattern to search for",
        },
        path: {
          type: "string",
          description: "The file or directory path to search in (relative to current directory)",
        },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: "read",
    description:
      "Read the contents of a file. Use this to examine files found by ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to read (relative to current directory)",
        },
      },
      required: ["path"],
    },
  },
];

/**
 * Executes a local tool and returns the result.
 */
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
    if (error instanceof z.ZodError) {
      return {
        error: `Invalid input for tool '${toolName}': ${error.errors.map(e => e.message).join(", ")}`,
      };
    }
    return {
      error: error instanceof Error ? error.message : "Unknown error during tool execution",
    };
  }
}

/**
 * Runs a tool loop using sampling.
 * Continues until the LLM provides a final answer.
 */
async function runToolLoop(
  server: McpServer,
  initialQuery: string
): Promise<string> {
  const messages: SamplingMessage[] = [
    {
      role: "user",
      content: {
        type: "text",
        text: initialQuery,
      },
    },
  ];

  const MAX_ITERATIONS = 10;
  let iteration = 0;

  const systemPrompt =
    "You are a helpful assistant that searches through files to answer questions. " +
    "You have access to ripgrep (for searching) and read (for reading file contents). " +
    "Use ripgrep to find relevant files, then read them to provide accurate answers. " +
    "All paths are relative to the current working directory. " +
    "Be concise and focus on providing the most relevant information.";

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Request message from LLM with available tools
    const response: CreateMessageResult = await server.server.createMessage({
      messages,
      systemPrompt,
      maxTokens: 4000,
      tools: LOCAL_TOOLS,
      tool_choice: { mode: "auto" },
    });

    // Add assistant's response to message history
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // Check if LLM wants to use a tool
    if (response.stopReason === "toolUse") {
      const toolCall = response.content as ToolCallContent;

      console.error(
        `[toolLoop] LLM requested tool: ${toolCall.name} with input:`,
        JSON.stringify(toolCall.input, null, 2)
      );

      // Execute the requested tool locally
      const toolResult = await executeLocalTool(toolCall.name, toolCall.input);

      console.error(
        `[toolLoop] Tool result:`,
        JSON.stringify(toolResult, null, 2)
      );

      // Add tool result to message history
      messages.push({
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: toolCall.id,
          content: toolResult,
        },
      });

      // Continue the loop to get next response
      continue;
    }

    // LLM provided final answer
    if (response.content.type === "text") {
      return response.content.text;
    }

    // Unexpected response type
    throw new Error(
      `Unexpected response content type: ${response.content.type}`
    );
  }

  throw new Error(`Tool loop exceeded maximum iterations (${MAX_ITERATIONS})`);
}

// Create and configure MCP server
const mcpServer = new McpServer({
  name: "tool-loop-sampling-server",
  version: "1.0.0",
});

// Register the fileSearch tool that uses sampling with a tool loop
mcpServer.registerTool(
  "fileSearch",
  {
    description:
      "Search for information in files using an AI assistant with ripgrep and file reading capabilities. " +
      "The assistant will intelligently use ripgrep to find relevant files and read them to answer your query.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "A natural language query describing what to search for (e.g., 'Find all TypeScript files that export a Server class')"
        ),
    },
  },
  async ({ query }) => {
    try {
      console.error(`[fileSearch] Processing query: ${query}`);

      const result = await runToolLoop(mcpServer, query);

      console.error(`[fileSearch] Final result: ${result.substring(0, 200)}...`);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(`[fileSearch] Error: ${errorMessage}`);

      return {
        content: [
          {
            type: "text",
            text: `Error performing file search: ${errorMessage}`,
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("MCP Tool Loop Sampling Server is running...");
  console.error(`Working directory: ${CWD}`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
