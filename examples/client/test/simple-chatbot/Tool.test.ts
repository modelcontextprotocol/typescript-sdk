import { describe, expect, it } from 'vitest';

import { Tool } from '../../src/simple-chatbot/Tool.js';

describe('Tool', () => {
  it('constructs with required fields', () => {
    const tool = new Tool({
      name: 'ping',
      description: 'Returns a canned response',
      inputSchema: { type: 'object' },
      title: 'Ping Tool',
    });

    expect(tool.name).toBe('ping');
    expect(tool.description).toBe('Returns a canned response');
    expect(tool.inputSchema).toEqual({ type: 'object' });
    expect(tool.title).toBe('Ping Tool');
  });

  it('formatForLlm throws until implemented', () => {
    const tool = new Tool({
      name: 'ping',
      description: 'Returns a canned response',
      inputSchema: { type: 'object' },
    });

    expect(() => tool.formatForLlm()).toThrow('Not implemented');
  });

  it.skip('formats tool details for LLM prompts', () => {
    const tool = new Tool({
      name: 'ping',
      title: 'Ping Tool',
      description: 'Returns a canned response',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
    });

    const output = tool.formatForLlm();

    expect(output).toContain('Tool: ping');
    expect(output).toContain('User-readable title: Ping Tool');
    expect(output).toContain('Description: Returns a canned response');
    expect(output).toContain('- message: Message to echo (required)');
  });
});
