import { Client } from '@modelcontextprotocol/client';
import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServersConfig } from './Configuration.js';

export type ServerConfigEntry = McpServersConfig['mcpServers'][string];

export class Server {
  public readonly name: string;
  private config: ServerConfigEntry;
  private client: Client | null = null;
  private childProcess: ChildProcess | null = null;

  constructor(name: string, config: ServerConfigEntry) {
    this.name = name;
    this.config = config;
  }

  async initialize(): Promise<void> {
    // TODO: Spawn process, connect client
    throw new Error('Not implemented');
  }

  async listTools(): Promise<any[]> {
    // TODO: Call client.request for tools/list
    throw new Error('Not implemented');
  }

  async executeTool(
    toolName: string,
    args: Record<string, any>,
    retries = 2,
    delay = 1000
  ): Promise<any> {
    // TODO: Execute tool with retry logic
    throw new Error('Not implemented');
  }

  async cleanup(): Promise<void> {
    // TODO: Close client and kill process
    throw new Error('Not implemented');
  }
}
