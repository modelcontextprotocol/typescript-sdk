import type Anthropic from '@anthropic-ai/sdk';
import type { GenerateContentResponse } from '@google/genai';
import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { fromAnthropicResponse, toAnthropicRequest } from '../providers/anthropic';
import { fromGeminiResponse, toGeminiRequest } from '../providers/gemini';
import { fromOpenAIResponse, toOpenAIRequest } from '../providers/openai';
import type { ChatMessage, GenerateRequest } from '../providers/provider';
import { ScriptedProvider } from '../providers/scripted';

const TOOL_SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

const conversation: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'add a task' }] },
    {
        role: 'assistant',
        content: [{ type: 'text', text: 'adding it' }],
        toolCalls: [
            { id: 'call_1', name: 'mcp__todos__add_task', arguments: { title: 'Write the report' } },
            { id: 'call_2', name: 'mcp__todos__list_tasks', arguments: {} }
        ]
    },
    { role: 'tool', toolCallId: 'call_1', toolName: 'mcp__todos__add_task', content: [{ type: 'text', text: 'Added t1' }] },
    { role: 'tool', toolCallId: 'call_2', toolName: 'mcp__todos__list_tasks', content: [{ type: 'text', text: 'boom' }], isError: true }
];

const request: GenerateRequest = {
    system: 'be helpful',
    messages: conversation,
    tools: [{ name: 'mcp__todos__add_task', description: 'Add a task', inputSchema: TOOL_SCHEMA }],
    maxTokens: 256
};

describe('anthropic mapping', () => {
    it('builds a Messages API request with namespaced tools, tool_use blocks, and merged tool_result messages', () => {
        const params = toAnthropicRequest(request, 'claude-test');
        expect(params.model).toBe('claude-test');
        expect(params.system).toBe('be helpful');
        expect(params.tools?.[0]).toMatchObject({ name: 'mcp__todos__add_task', input_schema: { type: 'object' } });

        expect(params.messages).toHaveLength(3);
        const assistant = params.messages[1];
        expect(assistant?.role).toBe('assistant');
        const assistantBlocks = assistant?.content as Anthropic.ContentBlockParam[];
        expect(assistantBlocks.filter(block => block.type === 'tool_use')).toHaveLength(2);

        // Both tool results (parallel calls) must land in ONE user message.
        const toolResults = params.messages[2];
        expect(toolResults?.role).toBe('user');
        const blocks = toolResults?.content as Anthropic.ToolResultBlockParam[];
        expect(blocks.map(block => block.type)).toEqual(['tool_result', 'tool_result']);
        expect(blocks[0]?.is_error).toBe(false);
        expect(blocks[1]?.is_error).toBe(true);
    });

    it('parses text, tool calls, and stop reasons from a response', () => {
        const response = {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [
                { type: 'text', text: 'on it', citations: null },
                { type: 'tool_use', id: 'call_9', name: 'mcp__todos__add_task', input: { title: 'x' } }
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 }
            // The fixture only carries the fields the mapping reads.
        } as unknown as Anthropic.Message;
        const result = fromAnthropicResponse(response);
        expect(result.text).toBe('on it');
        expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'mcp__todos__add_task', arguments: { title: 'x' } }]);
        expect(result.stopReason).toBe('tool_use');
    });
});

describe('openai mapping', () => {
    it('builds a Chat Completions request with function tools, tool_calls, and tool-role results', () => {
        const params = toOpenAIRequest(request, 'gpt-test');
        expect(params.model).toBe('gpt-test');
        expect(params.messages[0]).toEqual({ role: 'system', content: 'be helpful' });
        expect(params.tools?.[0]).toMatchObject({ type: 'function', function: { name: 'mcp__todos__add_task', parameters: TOOL_SCHEMA } });

        const assistant = params.messages.find(message => message.role === 'assistant');
        expect(assistant && 'tool_calls' in assistant && assistant.tool_calls).toHaveLength(2);
        const toolMessages = params.messages.filter(message => message.role === 'tool');
        expect(toolMessages).toHaveLength(2);
        expect(toolMessages[1]?.content).toContain('[tool error]');
    });

    it('parses tool calls (including malformed JSON arguments) from a response', () => {
        const response = {
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-test',
            choices: [
                {
                    index: 0,
                    finish_reason: 'tool_calls',
                    logprobs: null,
                    message: {
                        role: 'assistant',
                        content: null,
                        refusal: null,
                        tool_calls: [
                            { id: 'a', type: 'function', function: { name: 'mcp__todos__add_task', arguments: '{"title":"x"}' } },
                            { id: 'b', type: 'function', function: { name: 'mcp__todos__list_tasks', arguments: 'not json' } }
                        ]
                    }
                }
            ]
        } as unknown as OpenAI.Chat.Completions.ChatCompletion;
        const result = fromOpenAIResponse(response);
        expect(result.toolCalls).toEqual([
            { id: 'a', name: 'mcp__todos__add_task', arguments: { title: 'x' } },
            { id: 'b', name: 'mcp__todos__list_tasks', arguments: {} }
        ]);
        expect(result.stopReason).toBe('tool_use');
    });
});

describe('gemini mapping', () => {
    it('passes MCP JSON Schema through and maps tool results to functionResponse parts', () => {
        const params = toGeminiRequest(request, 'gemini-test');
        expect(params.model).toBe('gemini-test');
        const config = params.config;
        expect(config?.systemInstruction).toBe('be helpful');
        expect(config?.tools?.[0]).toMatchObject({
            functionDeclarations: [{ name: 'mcp__todos__add_task', parametersJsonSchema: TOOL_SCHEMA }]
        });

        const contents = params.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
        expect(contents).toHaveLength(3);
        expect(contents[1]?.role).toBe('model');
        expect(contents[1]?.parts?.some(part => 'functionCall' in part)).toBe(true);
        // Results for parallel function calls must share one user turn.
        expect(contents[2]?.parts?.[0]).toMatchObject({ functionResponse: { name: 'mcp__todos__add_task' } });
        expect(contents[2]?.parts?.[1]).toMatchObject({ functionResponse: { response: { isError: true } } });
    });

    it('parses text and function calls from a response, generating ids when missing', () => {
        const response = {
            candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            functionCalls: [{ name: 'mcp__todos__add_task', args: { title: 'x' } }],
            text: 'done'
        } as unknown as GenerateContentResponse;
        const result = fromGeminiResponse(response, 'gemini-test');
        expect(result.text).toBe('done');
        expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'mcp__todos__add_task', arguments: { title: 'x' } }]);
        expect(result.stopReason).toBe('tool_use');
    });
});

describe('scripted provider', () => {
    it('replays turns in order and reports leftovers', async () => {
        const provider = new ScriptedProvider([{ text: 'one' }, { toolCalls: [{ id: 'c', name: 't', arguments: {} }] }]);
        const first = await provider.generate({ messages: [] });
        expect(first.text).toBe('one');
        const second = await provider.generate({ messages: [] });
        expect(second.stopReason).toBe('tool_use');
        expect(provider.remaining).toBe(0);
        const exhausted = await provider.generate({ messages: [] });
        expect(exhausted.text).toContain('no turns left');
    });
});
