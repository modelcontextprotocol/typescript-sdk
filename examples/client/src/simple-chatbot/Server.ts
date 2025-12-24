import { Client, StdioClientTransport, type Tool } from '@modelcontextprotocol/client';

import type { McpServersConfig } from './Configuration.js';

export type ServerConfigEntry = McpServersConfig['mcpServers'][string];

export class Server {
  public readonly name: string;
  private config: ServerConfigEntry;
  private client: Client | null = null;
  public childPid: number | null = null;
  private transport: StdioClientTransport | null = null;
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
    _retries = 2,
    _delay = 1000
  ): Promise<undefined> {
    // TODO: Execute tool with retry logic
    throw new Error('Not implemented');
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
        // Align with Python behavior: log but do not rethrow
        console.error(`Error during cleanup of server ${this.name}:`, error);
      }
    });

    return this.cleanupChain;
  }
}
