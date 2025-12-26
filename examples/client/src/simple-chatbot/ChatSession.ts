import type { LLMClient } from './LLMClient.js';
import type { Server } from './Server.js';

/** Orchestrates the interaction between user, LLM, and tools. */
export class ChatSession {
  constructor(
    public readonly servers: Server[],
    public readonly llmClient: LLMClient
  ) {}

  async cleanupServers(): Promise<void> {
    // intentionally left blank for parity with Python stub
  }

  /** Process the LLM response and execute tools if needed. */
  async processLlmResponse(llmResponse: string): Promise<string> {
    return llmResponse;
  }

  /** Main chat session handler. */
  async start(): Promise<void> {
    // intentionally left blank for parity with Python stub
  }
}
