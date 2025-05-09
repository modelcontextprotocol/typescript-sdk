import Fastify from "fastify";
import { McpServer } from "../../server/mcp.js";
import { StreamableHTTPServerTransportOptions } from "../../server/streamableHttp.js";
import { RawHttpServerAdapter } from "../../server/raw-http-adapter.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CallToolResult, GetPromptResult, ReadResourceResult } from '../../types.js';

async function runFastifyMCPServer() {
  const fastify = Fastify({ logger: true });

  const mcpAdapterOptions: StreamableHTTPServerTransportOptions = {
    sessionIdGenerator: () => randomUUID(),
    // For true JSON request/response (non-SSE) for POSTs, uncomment the next line.
    // Otherwise, POST requests that expect a response will use an SSE stream.
    // enableJsonResponse: true,
  };
  const mcpAdapter = new RawHttpServerAdapter(mcpAdapterOptions);

  const mcpServer = new McpServer({
    name: "simple-streamable-http-server",
    version: "1.0.0",
  }, { capabilities: { logging: {} } });

  // === Tools, Resource, and Prompt from simpleStreamableHttp.ts ===

  // Tool: greet
  mcpServer.tool(
    'greet',
    'A simple greeting tool',
    {
      name: z.string().describe('Name to greet'),
    },
    async ({ name }): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: 'text',
            text: `Hello, ${name}!`,
          },
        ],
      };
    }
  );

  // Tool: multi-greet
  mcpServer.tool(
    'multi-greet',
    'A tool that sends different greetings with delays between them',
    {
      name: z.string().describe('Name to greet'),
    },
    {
      title: 'Multiple Greeting Tool', 
      readOnlyHint: true,
      openWorldHint: false
    },
    async ({ name }, { sendNotification }): Promise<CallToolResult> => {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

      await sendNotification({
        method: "notifications/message",
        params: { level: "debug", data: `Starting multi-greet for ${name}` }
      });

      await sleep(1000); // Wait 1 second before first greeting

      await sendNotification({
        method: "notifications/message",
        params: { level: "info", data: `Sending first greeting to ${name}` }
      });

      await sleep(1000); // Wait another second before second greeting

      await sendNotification({
        method: "notifications/message",
        params: { level: "info", data: `Sending second greeting to ${name}` }
      });

      return {
        content: [
          {
            type: 'text',
            text: `Good morning, ${name}!`,
          }
        ],
      };
    }
  );

  // Tool: start-notification-stream
  mcpServer.tool(
    'start-notification-stream',
    'Starts sending periodic notifications for testing resumability',
    {
      interval: z.number().describe('Interval in milliseconds between notifications').default(100),
      count: z.number().describe('Number of notifications to send (0 for 100)').default(50),
    },
    async ({ interval, count }, { sendNotification }): Promise<CallToolResult> => {
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      let counter = 0;

      while (count === 0 || counter < count) {
        counter++;
        try {
          await sendNotification({
            method: "notifications/message",
            params: {
              level: "info",
              data: `Periodic notification #${counter} at ${new Date().toISOString()}`
            }
          });
        }
        catch (error) {
          console.error("Error sending notification:", error);
        }
        await sleep(interval);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Started sending periodic notifications every ${interval}ms`,
          }
        ],
      };
    }
  );

  // Resource: greeting-resource
  mcpServer.resource(
    'greeting-resource',
    'https://example.com/greetings/default',
    { mimeType: 'text/plain' },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: 'https://example.com/greetings/default',
            text: 'Hello, world!',
          },
        ],
      };
    }
  );

  // Prompt: greeting-template
  mcpServer.prompt(
    'greeting-template',
    'A simple greeting prompt template',
    {
      name: z.string().describe('Name to include in greeting'),
    },
    async ({ name }): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please greet ${name} in a friendly manner.`,
            },
          },
        ],
      };
    }
  );

  // === End of copied tools, resource, and prompt ===
  
  await mcpServer.connect(mcpAdapter);

  // Register a catch-all route for the /mcp endpoint
  fastify.all("/mcp", async (request, reply) => {
    try {
      await mcpAdapter.handleNodeRequest(
        { raw: request.raw, body: request.body },
        { raw: reply.raw }
      );
      // IMPORTANT for SSE: Do not let Fastify automatically end the response here.
      // The mcpAdapter (via StreamableHTTPServerTransport) will manage the response stream (reply.raw).
    } catch (error) {
      fastify.log.error(error, "Error in MCP request handler");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Internal Server Error" },
            id: null,
          })
        );
      }
    }
  });

  try {
    const address = await fastify.listen({ port: 3000, host: "0.0.0.0" });
    fastify.log.info(`MCP Server (Fastify with tools from simpleStreamableHttp) listening on ${address}`);
    fastify.log.info(`MCP endpoint available at POST ${address}/mcp`);
    fastify.log.info(`Available tools: greet, multi-greet, start-notification-stream`);
    fastify.log.info(`Available resource: GET https://example.com/greetings/default (via MCP readResource)`);
    fastify.log.info(`Available prompt: greeting-template`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

runFastifyMCPServer();
