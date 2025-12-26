import { describe, expect, it, vi } from 'vitest';

import { ChatSession } from '../../src/simple-chatbot/ChatSession.js';
import type { LLMClient } from '../../src/simple-chatbot/LLMClient.js';
import type { Server } from '../../src/simple-chatbot/Server.js';

describe('ChatSession', () => {
  const mockServer: Server = {
    initialize: vi.fn(),
    listTools: vi.fn(),
    executeTool: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as Server;

  const mockLlmClient: LLMClient = {
    getResponse: vi.fn(),
  } as unknown as LLMClient;

  it('constructs with provided servers and llm client', () => {
    const session = new ChatSession([mockServer], mockLlmClient);
    expect(session.servers).toEqual([mockServer]);
    expect(session.llmClient).toBe(mockLlmClient);
  });

  it('processLlmResponse returns input by default', async () => {
    const session = new ChatSession([mockServer], mockLlmClient);
    const echo = await session.processLlmResponse('hello');
    expect(echo).toBe('hello');
  });

  it('cleanupServers resolves without throwing', async () => {
    const session = new ChatSession([mockServer], mockLlmClient);
    await expect(session.cleanupServers()).resolves.toBeUndefined();
  });
});
