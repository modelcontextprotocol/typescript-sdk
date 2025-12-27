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

  it('formats tool details for LLM prompts', () => {
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
      execution: { taskSupport: 'forbidden' },
    });

    const output = tool.formatForLlm();

    const expected =
      'Tool: ping\n' +
      'User-readable title: Ping Tool\n' +
      'Description: Returns a canned response\n' +
      'Arguments:\n' +
      '- message: Message to echo (required)\n';

    expect(output).toBe(expected);
   });
});
