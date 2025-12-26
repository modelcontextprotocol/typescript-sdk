import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

import type { McpServersConfig } from './Configuration.js';
import { Tool } from './Tool.js';

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

  async listTools(): Promise<Tool[]> {
    if (!this.client) {
      throw new Error(`Server ${this.name} not initialized`);
    }
    const toolsResponse = await this.client.listTools();
    if (!toolsResponse || !toolsResponse.tools || !Array.isArray(toolsResponse.tools)) {
      throw new Error(`Unexpected tools response from ${this.name}`);
    }
    return toolsResponse.tools.map((tool) =>
      new Tool({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? {},
        title: tool.title ?? null,
      })
    );
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    retries = 2,
    delay = 1000
  ) {
    if(!this.client) {
      throw new Error(`Server ${this.name} not initialized`);
    }
    let attempt = 0;
    while (attempt < retries) {
      console.info(`Server ${this.name}: executing tool ${toolName}, attempt ${attempt + 1} of ${retries}`);
      try {
        return await this.client.callTool({
          name: toolName,
          arguments: args
        });
      } catch (err) {
        attempt ++;
        if (attempt >= retries) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
     throw new Error(`Failed to execute tool ${toolName}. Attempt ${attempt} of ${retries}`);
  }

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
        console.error(`Error during cleanup of server ${this.name}:`, error);
      }
    });

    return this.cleanupChain;
  }
}
