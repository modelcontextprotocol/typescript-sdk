/*
  This example demonstrates a tool loop using MCP sampling with locally defined tools.

  It exposes a "fileSearch" tool that uses an LLM with ripgrep and read capabilities
  to intelligently search and read files in the current directory.

  Usage:
    npx -y @modelcontextprotocol/inspector \
      npx -y --silent tsx src/examples/backfill/backfillSampling.ts -- \
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
  startLineInclusive: z.number().int().positive().optional(),
  endLineInclusive: z.number().int().positive().optional(),
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
  server: McpServer,
  pattern: string,
  path: string
): Promise<{ output?: string; error?: string }> {
  try {
    await server.sendLoggingMessage({
      level: "info",
      data: `Searching pattern "${pattern}" under ${path}`,
    });

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
 * Reads a file from the filesystem, optionally within a line range.
 * Returns file contents as a string.
 */
async function executeRead(
  server: McpServer,
  path: string,
  startLineInclusive?: number,
  endLineInclusive?: number
): Promise<{ content?: string; error?: string }> {
  try {
    // Log the read operation
    if (startLineInclusive !== undefined || endLineInclusive !== undefined) {
      await server.sendLoggingMessage({
        level: "info",
        data: `Reading file ${path} (lines ${startLineInclusive ?? 1}-${endLineInclusive ?? "end"})`,
      });
    } else {
      await server.sendLoggingMessage({
        level: "info",
        data: `Reading file ${path}`,
      });
    }

    const safePath = ensureSafePath(path);
    const content = await readFile(safePath, "utf-8");
    const lines = content.split("\n");

    // If line range specified, extract only those lines
    if (startLineInclusive !== undefined || endLineInclusive !== undefined) {
      const start = (startLineInclusive ?? 1) - 1; // Convert to 0-indexed
      const end = endLineInclusive ?? lines.length; // Default to end of file

      if (start < 0 || start >= lines.length) {
        return { error: `Start line ${startLineInclusive} is out of bounds (file has ${lines.length} lines)` };
      }
      if (end < start) {
        return { error: `End line ${endLineInclusive} is before start line ${startLineInclusive}` };
      }

      const selectedLines = lines.slice(start, end);
      // Add line numbers to output
      const numberedContent = selectedLines
        .map((line, idx) => `${start + idx + 1}: ${line}`)
        .join("\n");

      return { content: numberedContent };
    }

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
      "Read the contents of a file. Use this to examine files found by ripgrep. " +
      "You can optionally specify a line range to read only specific lines. " +
      "Tip: When ripgrep finds matches, note the line numbers and request a few lines before and after for context.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path to read (relative to current directory)",
        },
        startLineInclusive: {
          type: "number",
          description: "Optional: First line to read (1-indexed, inclusive). Use with endLineInclusive to read a specific range.",
        },
        endLineInclusive: {
          type: "number",
          description: "Optional: Last line to read (1-indexed, inclusive). If not specified, reads to end of file.",
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
  server: McpServer,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    switch (toolName) {
      case "ripgrep": {
        const validated = RipgrepInputSchema.parse(toolInput);
        return await executeRipgrep(server, validated.pattern, validated.path);
      }
      case "read": {
        const validated = ReadInputSchema.parse(toolInput);
        return await executeRead(
          server,
          validated.path,
          validated.startLineInclusive,
          validated.endLineInclusive
        );
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
): Promise<{ answer: string; transcript: SamplingMessage[] }> {
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
    // Note that SamplingMessage.content doesn't yet support arrays, so we flatten the content into multiple messages.
    for (const content of (Array.isArray(response.content) ? response.content : [response.content])) {
      messages.push({
        role: "assistant",
        content,
      });
    }

    // Check if LLM wants to use tools
    if (response.stopReason === "toolUse") {
      // Extract all tool_use content blocks
      const contentArray = Array.isArray(response.content) ? response.content : [response.content];
      const toolCalls = contentArray.filter(
        (content): content is ToolCallContent => content.type === "tool_use"
      );

      // Log iteration with tool invocation count
      await server.sendLoggingMessage({
        level: "info",
        data: `Loop iteration ${iteration}: ${toolCalls.length} tool invocation(s) requested`,
      });

      // Execute all tools in parallel
      const toolResultPromises = toolCalls.map(async (toolCall) => {
        const result = await executeLocalTool(server, toolCall.name, toolCall.input);

        return { toolCall, result };
      });

      const toolResults = await Promise.all(toolResultPromises);

      // Add all tool results to message history
      for (const { toolCall, result } of toolResults) {
        messages.push({
          role: "user",
          content: {
            type: "tool_result",
            toolUseId: toolCall.id,
            content: result,
          },
        });
      }

      // Continue the loop to get next response
      continue;
    }

    // LLM provided final answer (no tool use)
    // Extract all text content blocks and concatenate them
    const contentArray = Array.isArray(response.content) ? response.content : [response.content];
    const textBlocks = contentArray.filter(
      (content): content is { type: "text"; text: string } => content.type === "text"
    );

    if (textBlocks.length > 0) {
      const answer = textBlocks.map(block => block.text).join("\n\n");

      // Log completion
      await server.sendLoggingMessage({
        level: "info",
        data: `Tool loop completed after ${iteration} iteration(s)`,
      });

      return { answer, transcript: messages };
    }

    // Unexpected response type
    const contentTypes = contentArray.map(c => c.type).join(", ");
    throw new Error(
      `Unexpected response content types: ${contentTypes}`
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
      const { answer, transcript } = await runToolLoop(mcpServer, query);
      return {
        content: [
          {
            type: "text",
            text: answer,
          },
          {
            type: "text",
            text: `\n\n--- Debug Transcript (${transcript.length} messages) ---\n${JSON.stringify(transcript, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : `${error}`,
            isError: true,
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
