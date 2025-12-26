import type { LLMClient } from './LLMClient.js';
import type { Server } from './Server.js';

export class ChatSession {
  constructor(
    public readonly servers: Server[],
    public readonly llmClient: LLMClient
  ) {}

  async cleanupServers(): Promise<void> {
    // intentionally left blank for parity with Python stub
  }

  async processLlmResponse(llmResponse: string): Promise<string> {
    return llmResponse;
  }

  async start(): Promise<void> {
    // intentionally left blank for parity with Python stub
  }
}
