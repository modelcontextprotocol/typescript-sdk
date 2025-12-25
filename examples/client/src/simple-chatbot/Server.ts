import { Client, StdioClientTransport, type Tool } from '@modelcontextprotocol/client';

import type { McpServersConfig } from './Configuration.js';

export type ServerConfigEntry = McpServersConfig['mcpServers'][string];

export class Server {
  public readonly name: string;
  private config: ServerConfigEntry;
  public client: Client | null = null;
  public childPid: number | null = null;
  public transport: StdioClientTransport | null = null;
  // Serializes teardown to prevent concurrent cleanup races
  private cleanupChain: Promise<void> = Promise.resolve();

  constructor(name: string, config: ServerConfigEntry) {
    this.name = name;
    this.config = config;
  }

  async initialize(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: this.config.env,
    });

    const client = new Client({
      name: `multi-server-chatbot-${this.name}`,
      version: '1.0.0',
    });

    await client.connect(transport);

    this.transport = transport;
    this.client = client;
    this.childPid = transport.pid;
  }

  async listTools():  Promise<Tool[]>{
    if(!this.client) {
      throw new Error(`Server ${this.name} not initialized`);
    }
    const toolsResponse = await this.client.listTools();
    if(!toolsResponse || !toolsResponse.tools || !Array.isArray(toolsResponse.tools)) {
      throw new Error(`Unexpected tools response from ${this.name}`);
    }
    return toolsResponse.tools;
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    retries = 2,
    delay = 1000
  ) {
    // TODO: Execute tool with retry logic
    if(!this.client) {
      throw new Error(`Server ${this.name} not initialized`);
    }
    return this.client.callTool({
      name: toolName,
      arguments: args
    });
  }
    //   async def execute_tool(
    //     self,
    //     tool_name: str,
    //     arguments: dict[str, Any],
    //     retries: int = 2,
    //     delay: float = 1.0,
    // ) -> Any:
    //     """Execute a tool with retry mechanism.

    //     Args:
    //         tool_name: Name of the tool to execute.
    //         arguments: Tool arguments.
    //         retries: Number of retry attempts.
    //         delay: Delay between retries in seconds.

    //     Returns:
    //         Tool execution result.

    //     Raises:
    //         RuntimeError: If server is not initialized.
    //         Exception: If tool execution fails after all retries.
    //     """
    //     if not self.session:
    //         raise RuntimeError(f"Server {self.name} not initialized")

    //     attempt = 0
    //     while attempt < retries:
    //         try:
    //             logging.info(f"Executing {tool_name}...")
    //             result = await self.session.call_tool(tool_name, arguments)

    //             return result

    //         except Exception as e:
    //             attempt += 1
    //             logging.warning(
    //                 f"Error executing tool: {e}. Attempt {attempt} of {retries}."
    //             )
    //             if attempt < retries:
    //                 logging.info(f"Retrying in {delay} seconds...")
    //                 await asyncio.sleep(delay)
    //             else:
    //                 logging.error("Max retries reached. Failing.")
    //                 raise


  async cleanup(): Promise<void> {
    this.cleanupChain = this.cleanupChain.then(async () => {
      let error: unknown;
      if (!(this.client || this.transport)) return;

      if (this.client) {
        try {
          await this.client.close();
        } catch (e) {
          error ??= e;
        }
        this.client = null;
      }

      if (this.transport) {
        try {
          await this.transport.close();
        } catch (e) {
          error ??= e;
        }
        this.transport = null;
      }

      this.childPid = null;

      if (error) {
        // Align with Python behavior: log but do not rethrow
        console.error(`Error during cleanup of server ${this.name}:`, error);
      }
    });

    return this.cleanupChain;
  }
}
