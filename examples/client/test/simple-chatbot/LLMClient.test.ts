import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChatMessage,LLMClient } from '../../src/simple-chatbot/LLMClient.js';

type FetchLike = (input: string, init?: unknown) => Promise<unknown>;
declare const global: typeof globalThis & { fetch?: FetchLike };

describe('LLMClient', () => {
  const apiKey = 'test-key';
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns content when fetch succeeds', async () => {
    const content = 'Hello back!';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
      text: async () => '',
    });
    global.fetch = fetchMock;

    const client = new LLMClient(apiKey);
    const result = await client.getResponse(messages);

    expect(result).toBe(content);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(Array.isArray(call)).toBe(true);
    const secondPar = (call![1] as Record<string, unknown>)['body'];
    expect(secondPar).toBeDefined();
    expect(secondPar).toContain('"messages":[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hello"}]');
  });

  it('returns friendly error when fetch fails', async () => {
    const errorMessage = 'Network down';
    const fetchMock = vi.fn().mockRejectedValue(new Error(errorMessage));
    global.fetch = fetchMock;

    const client = new LLMClient(apiKey);
    const result = await client.getResponse(messages);

    expect(result).toContain('I encountered an error');
    expect(result).toContain(errorMessage);
  });
});
