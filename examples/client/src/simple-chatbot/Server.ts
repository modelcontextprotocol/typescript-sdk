import { Client, StdioClientTransport, type Tool } from '@modelcontextprotocol/client';

import type { McpServersConfig } from './Configuration.js';

export type ServerConfigEntry = McpServersConfig['mcpServers'][string];

export class Server {
  public readonly name: string;
  private config: ServerConfigEntry;
  private client: Client | null = null;
  public childPid: number | null = null;
  private transport: StdioClientTransport | null = null;

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

  //  async def list_tools(self) -> list[Any]:
  //       """List available tools from the server.

  //       Returns:
  //           A list of available tools.

  //       Raises:
  //           RuntimeError: If the server is not initialized.
  //       """
  //       if not self.session:
  //           raise RuntimeError(f"Server {self.name} not initialized")

  //       tools_response = await self.session.list_tools()
  //       tools = []

  //       for item in tools_response:
  //           if isinstance(item, tuple) and item[0] == "tools":
  //               tools.extend(
  //                   Tool(tool.name, tool.description, tool.inputSchema, tool.title)
  //                   for tool in item[1]
  //               )

  //       return tools

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    _retries = 2,
    _delay = 1000
  ): Promise<undefined> {
    // TODO: Execute tool with retry logic
    throw new Error('Not implemented');
  }

  async cleanup(): Promise<void> {
    // TODO: Close client and kill process
    throw new Error('Not implemented');
  }
}
