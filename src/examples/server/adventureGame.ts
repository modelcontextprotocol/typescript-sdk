/*
  This example demonstrates a tool loop using MCP sampling with locally defined tools.

  It exposes a "localResearch" tool that uses an LLM with ripgrep and read capabilities
  to intelligently search and read files in the current directory.

  Usage:
    npx -y @modelcontextprotocol/inspector \
      npx -- -y --silent tsx src/examples/backfill/backfillSampling.ts \
        npx -y --silent tsx src/examples/server/adventureGame.ts

    claude mcp add game -- \
      npx -y --silent tsx src/examples/backfill/backfillSampling.ts \
      npx -y --silent tsx src/examples/server/adventureGame.ts

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
          npm run --silent examples:adventure-game

  Then connect with an MCP client and call the "localResearch" tool with a query like:
    "Find all TypeScript files that export a Server class"
*/

import { McpError, ErrorCode } from "../../types.js";
import { McpServer } from "../../server/mcp.js";

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
ElicitRequest,
} from "../../types.js";
import { ElicitResultSchema } from "../../../dist/esm/types.js";
import { ToolRegistry } from "./toolRegistry.js";
import { runToolLoop, BreakToolLoopError } from "./toolLoop.js" 


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
  userLost: {
    description: "Called when the user loses",
    inputSchema: z.object({
      storyUpdate: z.string(),
    }),
    callback: async ({storyUpdate}, extra) => {
      await extra.sendRequest(<ElicitRequest>{
          method: 'elicitation/create',
          params: {
              message: 'You Lost!\n' + storyUpdate,
              requestedSchema: {
                  type: 'object',
                  properties: {},
              },
          },
      }, ElicitResultSchema);
      throw new BreakToolLoopError('lost');
    }
  },
  userWon: {
    description: "Called when the user wins the game",
    inputSchema: z.object({
      storyUpdate: z.string(),
    }),
    callback: async ({storyUpdate}, extra) => {
      await extra.sendRequest(<ElicitRequest>{
          method: 'elicitation/create',
          params: {
              message: 'You Won!\n' + storyUpdate,
              requestedSchema: {
                  type: 'object',
                  properties: {},
              },
          },
      }, ElicitResultSchema);
      throw new BreakToolLoopError('won');
    }
  },
  nextStep: {
    description: "Next step in the game.",
    inputSchema: z.object({
        storyUpdate: z.string().describe("Description of the next step of the game. Acknowledges the last decision (if any) and describes what happened becaus of / since it was made, then continues the story up to the point where another decision is needed from the user (if/when appropriate)."),
        nextDecisions: z.array(z.string()).describe("The list of possible decisions the user/player can make at this point of the story. Empty list if we've reached the end of the story"),
        decisionTimeoutSeconds: z.number().optional().describe("Optional: timeout in seconds for decision to be made. Used when a timely decision is needed.")
    }),
    outputSchema: z.object({
      userDecision: z.string().optional()
        .describe("The decision the user took, or undefined if the user let the decision time out. The game master may decide that failure to respond with in the time out means the user's character stayed still / failed to defend themselves, for instance."),
    }),
    callback: async ({storyUpdate, nextDecisions, decisionTimeoutSeconds}, extra) => {
      try {
        const result = await extra.sendRequest(<ElicitRequest>{
            method: 'elicitation/create',
            params: {
                message: storyUpdate,
                requestedSchema: {
                    type: 'object',
                    properties: {
                        nextDecision: {
                            title: 'Next step',
                            type: 'string',
                            enum: nextDecisions,
                        },
                    },
                },
            },
        }, ElicitResultSchema, {
          timeout: decisionTimeoutSeconds === undefined ? undefined: decisionTimeoutSeconds * 1000,
        });

        if (result.action === 'accept') {
            const structuredContent = {
              userDecision: result.content?.nextDecision as string,
            };
            return {
              content: [{type: 'text', text: JSON.stringify(structuredContent)}],
              structuredContent,
            };
        } else {
          return {
            content: [{type: 'text', text: result.action === 'decline' ? 'Game Over' : 'Game Cancelled'}],
          }
        }
      } catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
          const structuredContent = {
              userDecision: undefined // Means "timeed out".
          };
          return {
            content: [{type: 'text', text: JSON.stringify(structuredContent)}],
            structuredContent,
          };
        }
        return makeErrorCallToolResult(error);
      }
    }
  }
});

// Create and configure MCP server
const mcpServer = new McpServer({
  name: "adventure-game",
  version: "1.0.0",
});

// Register the localResearch tool that uses sampling with a tool loop
mcpServer.registerTool(
  "choose_your_own_adventure_game",
  {
    description: "Play a game. The user will be asked for decisions along the way.",
    inputSchema: {
      gameSynopsisOrSubject: z
        .string()
        .describe(
          "Description of the game subject or possible synopsis."
        ),
    },
  },
  async ({ gameSynopsisOrSubject }, extra) => {
    try {
      const { answer, transcript, usage } = await runToolLoop({
        initialMessages: [{
          role: "user",
          content: {
            type: "text",
            text: gameSynopsisOrSubject,
          },
        }],
        systemPrompt:
          "You are a 'choose your own adventure' game master. " +
          "Given an initial user request (subject and/or synopsis of the game, maybe description of their role in the game), " +
          "you will relentlessly walk the user forward in an imaginary story, " +
          "giving them regular choices as to what their character can do next can happen next. " +
          "If the user didn't choose a role for themselves, you can ask them to pick one of a few interesting options (first decision). " +
          "Then you will continually develop the story and call the nextStep too to give story updates and ask for pivotal decisions. " + 
          "Updates should fit in a page (sometimes as short as a paragraph e.g. if doing a battle with very fast paced action). " +
          "Some decisions should have a timeout to create some thrills for the user, in tight action scenes. " + 
          "When / if the user loses (e.g. dies, or whatever the user expressed as a loss condition), the last call to nextStep should have zero options.",
        defaultToolChoice: {mode: 'required'},
        server: mcpServer,
        registry,
      }, extra);

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
      return makeErrorCallToolResult(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("'MCP Choose Your Own Adventure Game' Server is running...");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
