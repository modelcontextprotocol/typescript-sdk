import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

import type { McpServersConfig } from './Configuration.js';

export type ServerConfigEntry = McpServersConfig['mcpServers'][string];

export class Server {
  public readonly name: string;
  private config: ServerConfigEntry;
  private client: Client | null = null;
  private childPid: number | null = null;
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

  async listTools(): Promise<unknown[]> {
    // TODO: Call client.request for tools/list
    throw new Error('Not implemented');
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
    // TODO: Close client and kill process
    throw new Error('Not implemented');
  }
}
