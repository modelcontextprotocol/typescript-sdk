import type { LLMClient } from './LLMClient.js';
import type { Server } from './Server.js';
import type { Tool } from './Tool.js';
import { buildSystemPrompt } from './prompts.js';

/** Orchestrates the interaction between user, LLM, and tools. */
export class ChatSession {
  public availableTools: Tool[] = [];

  constructor(
    public readonly servers: Server[],
    public readonly llmClient: LLMClient
  ) { }


  async cleanupServers(): Promise<void> {
    // intentionally left blank for parity with Python stub
    // Clean up all servers properly (Python reference kept for parity)
    // for server in reversed(self.servers):
    //     try:
    //         await server.cleanup()
    //     except Exception as e:
    //         logging.warning(f"Warning during final cleanup: {e}")
  }

  /** Process the LLM response and execute tools if needed. */
  async processLlmResponse(llmResponse: string): Promise<string> {
    return llmResponse;
    // Python reference kept for parity
    // try:
    //     tool_call = json.loads(llm_response)
    //     if "tool" in tool_call and "arguments" in tool_call:
    //         ...
    //     return llm_response
    // except json.JSONDecodeError:
    //     return llm_response
  }

  /** Main chat session handler. */
  async start(): Promise<void> {
    // 1. Initialize all servers sequentially
    for (const server of this.servers) {
      try {
        await server.initialize();
      } catch (e) {
        console.error(`Failed to initialize server: ${e}`);
        await this.cleanupServers();
        return;
      }
    }

    // 2. List all tools from all servers
    const allTools: Tool[] = [];
    for (const server of this.servers) {
      const tools = await server.listTools();
      console.log("vippe tools from server", server.name, tools);
      if (Array.isArray(tools) && tools.length) {
        allTools.push(...tools);
      }
    }
    this.availableTools = allTools;
    const toolsDescription = allTools.map((tool) => tool.formatForLlm()).join("\n");
    const systemMessage = buildSystemPrompt(toolsDescription);
    console.log("system message", systemMessage);


    // 5. Enter chat loop: get user input, get LLM response, process response

    // Python reference kept for parity
    // try:
    //     for server in self.servers:
    //         ...
    // finally:
    //     await self.cleanup_servers()
  }
}
