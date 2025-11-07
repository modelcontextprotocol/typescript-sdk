import { McpServer, RegisteredTool } from "../../server/mcp.js";
import { RequestHandlerExtra } from "../../shared/protocol.js";
import { z } from "zod";
import type {
  Tool,
  ToolCallContent,
  ToolResultContent, 
  ServerRequest,
  ServerNotification,
} from "../../types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BreakToolLoopError } from "./toolLoop.js"


export class ToolRegistry {
  readonly tools: Tool[]

  constructor(private toolDefinitions: {[name: string]: Pick<RegisteredTool, 'title' | 'description' | 'inputSchema' | 'outputSchema' | 'annotations' | '_meta' | 'callback'> }) {
    this.tools = Object.entries(this.toolDefinitions).map(([name, tool]) => (<Tool>{
      name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema ? zodToJsonSchema(tool.inputSchema) : undefined,
      outputSchema: tool.outputSchema ? zodToJsonSchema(tool.outputSchema) : undefined,
      annotations: tool.annotations,
      _meta: tool._meta,
    }));
  }

  register(server: McpServer) {
    for (const [name, tool] of Object.entries(this.toolDefinitions)) {
      server.registerTool(name, {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      }, tool.callback as any);
    }
  }
  
  async callTools(toolCalls: ToolCallContent[], extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<ToolResultContent[]> {
      return Promise.all(toolCalls.map(async ({ name, id, input }) => {
          const tool = this.toolDefinitions[name];
          if (!tool) {
          throw new Error(`Tool ${name} not found`);
          }
          try {
            return <ToolResultContent>{
                type: "tool_result",
                toolUseId: id,
                // Copies fields: content, structuredContent?, isError?
                ...await tool.callback(input as any, extra),
            };
          } catch (error) {
            if (error instanceof BreakToolLoopError) {
              throw error;
            }
            throw new Error(`Tool ${name} failed: ${error instanceof Error ? `${error.message}\n${error.stack}` : error}`);
          }
      }));
  }
}
