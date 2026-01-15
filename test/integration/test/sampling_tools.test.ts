import { Client } from '@modelcontextprotocol/client';
import { CreateMessageRequestSchema, InMemoryTransport } from '@modelcontextprotocol/core';
import { Server } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';

describe('sampling/createMessage with tools', () => {
    test('should support returning tool calls when tools are provided', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client(
            { name: 'test client', version: '1.0' },
            {
                capabilities: {
                    sampling: {
                        tools: {}
                    }
                }
            }
        );

        // Implement request handler for sampling/createMessage that returns a tool call
        client.setRequestHandler(CreateMessageRequestSchema, async _request => {
            return {
                model: 'test-model',
                role: 'assistant',
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'tool_use',
                        id: 'call_1',
                        name: 'test_tool',
                        input: { arg: 'value' }
                    }
                ]
            };
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'use the tool' } }],
            maxTokens: 100,
            tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
        });

        expect(result).toEqual({
            model: 'test-model',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [
                {
                    type: 'tool_use',
                    id: 'call_1',
                    name: 'test_tool',
                    input: { arg: 'value' }
                }
            ]
        });
    });

    test('should fail if returning tool calls when tools are NOT provided', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new Client(
            { name: 'test client', version: '1.0' },
            {
                capabilities: {
                    sampling: {}
                }
            }
        );

        // Implement request handler for sampling/createMessage that returns a tool call
        client.setRequestHandler(CreateMessageRequestSchema, async _request => {
            return {
                model: 'test-model',
                role: 'assistant',
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'tool_use',
                        id: 'call_1',
                        name: 'test_tool',
                        input: { arg: 'value' }
                    }
                ]
            };
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // This should fail because the client validation will reject the tool call result
        // when validating against CreateMessageResultSchema (since tools were not requested)
        await expect(
            server.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: 'use the tool' } }],
                maxTokens: 100
                // No tools provided
            })
        ).rejects.toThrow();
    });
});
