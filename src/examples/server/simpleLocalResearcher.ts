/*
  This example demonstrates a tool loop using MCP sampling with locally defined tools.

  It exposes a "localResearch" tool that uses an LLM with ripgrep and read capabilities
  to intelligently search and read files in the current directory.

  Usage:
    npx -y @modelcontextprotocol/inspector \
      npx -- -y --silent tsx src/examples/backfill/backfillSampling.ts \
        npx -y --silent tsx src/examples/server/simpleLocalResearcher.ts

    claude mcp add sampling_with_tools -- \
      npx -y --silent tsx src/examples/backfill/backfillSampling.ts \
      npx -y --silent tsx src/examples/server/simpleLocalResearcher.ts

    # Or dockerized:
    rm -fR node_modules
    docker run --rm -v $PWD:/src -w /src node:latest npm i
    npx -y @modelcontextprotocol/inspector -- \
      docker run --rm -i -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
        -v $PWD:/src -w /src \
        $( echo "
          FROM node:latest
          RUN apt update && apt install ripgrep
        " | docker build -q -f - . ) \
          npm run --silent examples:tool-loop

  Then connect with an MCP client and call the "localResearch" tool with a query like:
    "Find all TypeScript files that export a Server class"
*/

import { McpServer,RegisteredTool,  } from "../../server/mcp.js";
import { StdioServerTransport } from "../../server/stdio.js";
import { RequestHandlerExtra } from "../../shared/protocol.js";
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
  RequestId,
  ServerRequest,
  ServerNotification,
} from "../../types.js";
import { ToolRegistry } from "./toolRegistry.js";
import { runToolLoop } from './toolLoop.js';

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

const registry = new ToolRegistry({
  ripgrep: {
    description:
      "Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.",
    inputSchema: z.object({
        pattern: z.string().describe("The regex pattern to search for"),
        path: z.string().describe("The file or directory path to search in (relative to current directory)"),
    }),
    callback: async ({pattern, path}, extra) => {
      try {
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
  },
  read: {
    description:
      "Read the contents of a file. Use this to examine files found by ripgrep. " +
      "You can optionally specify a line range to read only specific lines. " +
      "Tip: When ripgrep finds matches, note the line numbers and request a few lines before and after for context.",
    inputSchema: z.object({
      path: z.string().describe("The file path to read (relative to current directory)"),
      startLineInclusive: z.number().optional().describe("Optional: First line to read (1-indexed, inclusive). Use with endLineInclusive to read a specific range."),
      endLineInclusive: z.number().optional().describe("Optional: Last line to read (1-indexed, inclusive). If not specified, reads to end of file."),
    }),
    callback: async ({path, startLineInclusive, endLineInclusive}, _extra) => {
      try {
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
  }
});

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
  async ({ query, maxIterations }, extra) => {
    try {
      const MAX_ITERATIONS = 20;
      const { answer, transcript, usage } = await runToolLoop({
        initialMessages: [{
          role: "user",
          content: {
            type: "text",
            text: query,
          },
        }],
        systemPrompt:
          "You are a helpful assistant that searches through files to answer questions. " +
          "You have access to ripgrep (for searching) and read (for reading file contents). " +
          "Use ripgrep to find relevant files, then read them to provide accurate answers. " +
          "All paths are relative to the current working directory. " +
          "Be concise and focus on providing the most relevant information." +
          "You will be allowed up to " + MAX_ITERATIONS + " iterations of tool use to find the information needed. When you have enough information or reach the last iteration, provide a final answer.",
        maxIterations: MAX_ITERATIONS,
        server: mcpServer,
        registry,
      }, extra);

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

if (process.env.REGISTER_TOOLS === "1") {
  registry.register(mcpServer);
}

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
