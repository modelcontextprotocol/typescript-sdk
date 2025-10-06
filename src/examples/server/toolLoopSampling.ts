/*
  This example demonstrates a tool loop using MCP sampling with locally defined tools.

  It exposes a "localResearch" tool that uses an LLM with ripgrep and read capabilities
  to intelligently search and read files in the current directory.

  Usage:
    npx -y @modelcontextprotocol/inspector \
      npx -- -y --silent tsx src/examples/backfill/backfillSampling.ts \
        npx -y --silent tsx src/examples/server/toolLoopSampling.ts

  Then connect with an MCP client and call the "localResearch" tool with a query like:
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
  CreateMessageRequest,
  ToolResultContent, 
  CallToolResult,
} from "../../types.js";

const CWD = process.cwd();

/**
 * Interface for tracking aggregated token usage across API calls.
 */
interface AggregatedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  api_calls: number;
}

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


function makeErrorCallToolResult(error: any): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? `${error.message}\n${error.stack}` : `${error}`,
      },
    ],
    isError: true,
  }
}

/**
 * Executes ripgrep to search for a pattern in files.
 * Returns search results as a string.
 */
async function executeRipgrep(
  server: McpServer,
  pattern: string,
  path: string
): Promise<CallToolResult> {
  try {
    await server.sendLoggingMessage({
      level: "info",
      data: `Searching pattern "${pattern}" under ${path}`,
    });

    const safePath = ensureSafePath(path);

    const output = await new Promise<string>((resolve, reject) => {
      const command = ["rg", "--json", "--max-count", "50", "--", pattern, safePath];
      const rg = spawn(command[0], command.slice(1));

      let stdout = "";
      let stderr = "";
      rg.stdout.on("data", (data) => stdout += data.toString());
      rg.stderr.on("data", (data) => stderr += data.toString());
      rg.on("close", (code) => {
        if (code === 0 || code === 1) {
          // code 1 means no matches, which is fine
          resolve(stdout || "No matches found");
        } else {
          reject(new Error(`ripgrep exited with code ${code}:\n${stderr}`));
        }
      });
      rg.on("error", err => reject(new Error(`Failed to start \`${command.map(a => a.indexOf(' ') >= 0 ? `"${a}"` : a).join(' ')}\`: ${err.message}\n${stderr}`)));
    });
    const structuredContent = { output };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    return makeErrorCallToolResult(error);
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
): Promise<CallToolResult> {
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
    const fileContent = await readFile(safePath, "utf-8");
    if (typeof fileContent !== "string") {
      throw new Error(`Result of reading file ${path} is not text: ${fileContent}`);
    }
    
    let content = fileContent;

    // If line range specified, extract only those lines
    if (startLineInclusive !== undefined || endLineInclusive !== undefined) {
      const lines = fileContent.split("\n");
      
      const start = (startLineInclusive ?? 1) - 1; // Convert to 0-indexed
      const end = endLineInclusive ?? lines.length; // Default to end of file

      if (start < 0 || start >= lines.length) {
        throw new Error(`Start line ${startLineInclusive} is out of bounds (file has ${lines.length} lines)`);
      }
      if (end < start) {
        throw new Error(`End line ${endLineInclusive} is before start line ${startLineInclusive}`);
      }

      content = lines.slice(start, end)
          .map((line, idx) => `${start + idx + 1}: ${line}`)
          .join("\n");
    }

    const structuredContent = { content }
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    return makeErrorCallToolResult(error);
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
): Promise<CallToolResult> {
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
        return makeErrorCallToolResult(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return makeErrorCallToolResult(`Invalid input for tool '${toolName}': ${error.errors.map(e => e.message).join(", ")}`);
    }
    return makeErrorCallToolResult(error);
  }
}

/**
 * Runs a tool loop using sampling.
 * Continues until the LLM provides a final answer.
 */
async function runToolLoop(
  server: McpServer,
  initialQuery: string
): Promise<{ answer: string; transcript: SamplingMessage[]; usage: AggregatedUsage }> {
  const messages: SamplingMessage[] = [
    {
      role: "user",
      content: {
        type: "text",
        text: initialQuery,
      },
    },
  ];

  // Initialize usage tracking
  const aggregatedUsage: AggregatedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    api_calls: 0,
  };

  const MAX_ITERATIONS = 20;
  let iteration = 0;

  const systemPrompt =
    "You are a helpful assistant that searches through files to answer questions. " +
    "You have access to ripgrep (for searching) and read (for reading file contents). " +
    "Use ripgrep to find relevant files, then read them to provide accurate answers. " +
    "All paths are relative to the current working directory. " +
    "Be concise and focus on providing the most relevant information." +
    "You will be allowed up to " + MAX_ITERATIONS + " iterations of tool use to find the information needed. When you have enough information or reach the last iteration, provide a final answer.";

  let request: CreateMessageRequest["params"] | undefined
  let response: CreateMessageResult | undefined
  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Request message from LLM with available tools
    response = await server.server.createMessage(request = {
      messages,
      systemPrompt,
      maxTokens: 4000,
      tools: iteration < MAX_ITERATIONS ? LOCAL_TOOLS : undefined,
      // Don't allow tool calls at the last iteration: finish with an answer no matter what!
      tool_choice: { mode: iteration < MAX_ITERATIONS ? "auto" : "none" },
    });

    // Aggregate usage statistics from the response
    if (response._meta?.usage) {
      const usage = response._meta.usage as any;
      aggregatedUsage.input_tokens += usage.input_tokens || 0;
      aggregatedUsage.output_tokens += usage.output_tokens || 0;
      aggregatedUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
      aggregatedUsage.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
      aggregatedUsage.api_calls += 1;
    }

    // Add assistant's response to message history
    // SamplingMessage now supports arrays of content
    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stopReason === "toolUse") {
      const contentArray = Array.isArray(response.content) ? response.content : [response.content];
      const toolCalls = contentArray.filter(
        (content): content is ToolCallContent => content.type === "tool_use"
      );

      await server.sendLoggingMessage({
        level: "info",
        data: `Loop iteration ${iteration}: ${toolCalls.length} tool invocation(s) requested`,
      });

      const toolResults: ToolResultContent[] = await Promise.all(toolCalls.map(async (toolCall) => {
        const result = await executeLocalTool(server, toolCall.name, toolCall.input);
        return <ToolResultContent>{ 
          type: "tool_result",
          toolUseId: toolCall.id,
          content: result.content,
          structuredContent: result.structuredContent,
          isError: result.isError,
        }
      }))

      messages.push({
        role: "user",
        content: iteration < MAX_ITERATIONS ? toolResults : [
          ...toolResults,
          {
            type: "text",
            text: "Using the information retrieved from the tools, please now provide a concise final answer to the original question (last iteration of the tool loop).",
          }
        ],
      });
    } else if (response.stopReason === "endTurn") {
      const contentArray = Array.isArray(response.content) ? response.content : [response.content];
      const unexpectedBlocks = contentArray.filter(content => content.type !== "text");
      if (unexpectedBlocks.length > 0) {
        throw new Error(`Expected text content in final answer, but got: ${unexpectedBlocks.map(b => b.type).join(", ")}`);
      }
      
      await server.sendLoggingMessage({
        level: "info",
        data: `Tool loop completed after ${iteration} iteration(s)`,
      });

      return {
        answer: contentArray.map(block => block.text).join("\n\n"),
        transcript: messages,
        usage: aggregatedUsage
      };
    } else if (response?.stopReason === "maxTokens") {
      throw new Error("LLM response hit max tokens limit");
    } else {
      throw new Error(`Unsupported stop reason: ${response.stopReason}`);
    }
  }

  throw new Error(`Tool loop exceeded maximum iterations (${MAX_ITERATIONS}); request: ${JSON.stringify(request)}\nresponse: ${JSON.stringify(response)}`);
}

// Create and configure MCP server
const mcpServer = new McpServer({
  name: "tool-loop-sampling-server",
  version: "1.0.0",
});

// Register the localResearch tool that uses sampling with a tool loop
mcpServer.registerTool(
  "localResearch",
  {
    description:
      "Search for information in files using an AI assistant with ripgrep and file reading capabilities. " +
      "The assistant will intelligently use ripgrep to find relevant files and read them to answer your query.",
    inputSchema: {
      query: z
        .string()
        .default("describe main classes")
        .describe(
          "A natural language query describing what to search for (e.g., 'Find all TypeScript files that export a Server class')"
        ),
      maxIterations: z.number().int().positive().optional().default(20).describe("Maximum number of tool use iterations (default 20)"),
    },
  },
  async ({ query, maxIterations }) => {
    try {
      const { answer, transcript, usage } = await runToolLoop(mcpServer, query);

      // Calculate total input tokens
      const totalInputTokens =
        usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens;

      // Format usage summary
      const usageSummary =
        `--- Token Usage Summary ---\n` +
        `Total Input Tokens: ${totalInputTokens}\n` +
        `  - Regular: ${usage.input_tokens}\n` +
        `  - Cache Creation: ${usage.cache_creation_input_tokens}\n` +
        `  - Cache Read: ${usage.cache_read_input_tokens}\n` +
        `Total Output Tokens: ${usage.output_tokens}\n` +
        `Total Tokens: ${totalInputTokens + usage.output_tokens}\n` +
        `API Calls: ${usage.api_calls}`;

      return {
        content: [
          {
            type: "text",
            text: answer,
          },
          {
            type: "text",
            text: `\n\n${usageSummary}`,
          },
          {
            type: "text",
            text: `\n\n--- Debug Transcript (${transcript.length} messages) ---\n${JSON.stringify(transcript, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return makeErrorCallToolResult(error);
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
