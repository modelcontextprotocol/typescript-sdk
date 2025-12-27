import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSession } from '../../src/simple-chatbot/ChatSession.js';
import type { LLMClient } from '../../src/simple-chatbot/LLMClient.js';
import * as prompts from '../../src/simple-chatbot/prompts.js';
import type { Server } from '../../src/simple-chatbot/Server.js';
import type { Tool } from '../../src/simple-chatbot/Tool.js';

const fakeTools: Tool[] = [
  { name: 'ping', description: 'test', inputSchema: {}, title: 'Ping', execution: undefined, formatForLlm: () => 'Tool: ping\nDescription: test\nArguments:\n' } as Tool,
  { name: 'echo', description: 'test', inputSchema: {}, title: 'Echo', execution: undefined, formatForLlm: () => 'Tool: echo\nDescription: test\nArguments:\n' } as Tool,
];

const getServerMock = () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue(fakeTools),
  executeTool: vi.fn(),
  cleanup: vi.fn(),
} as unknown as Server);

describe('ChatSession', () => {
  let mockServer: Server;

  const mockLlmClient: LLMClient = {
    getResponse: vi.fn(),
  } as unknown as LLMClient;

  beforeEach(() => {
    mockServer = getServerMock();
  });

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

  describe('start', () => {
    let session: ChatSession;

    beforeEach(async () => {
      session = new ChatSession([mockServer, mockServer], mockLlmClient);
      await session.start();
    });
    it('initializes all servers', async () => {
      expect(mockServer.initialize).toHaveBeenCalledTimes(2);
    });
    it('gets the tools from all servers', async () => {
      expect(mockServer.listTools).toHaveBeenCalledTimes(2);
      expect(session.availableTools).toEqual([...fakeTools, ...fakeTools]);
    });
    it('should call the buildSystemPrompt function with the correct tools description ', async () => {
      const buildSystemPromptSpy = vi.spyOn(prompts, 'buildSystemPrompt');
      session = new ChatSession([mockServer, mockServer], mockLlmClient);
      await session.start();

      const toolsDescription = [...fakeTools, ...fakeTools]
        .map((tool) => tool.formatForLlm())
        .join('\n');
      expect(buildSystemPromptSpy).toHaveBeenCalledWith(toolsDescription);
    });


  });
});