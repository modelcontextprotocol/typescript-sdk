import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { completable, McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

describe('Issue #893: post-connect registration with pre-declared capabilities', () => {
    test('registers a tool after connect when capabilities.tools is pre-declared', async () => {
        const server = new McpServer({ name: 'test-server', version: '1.0' }, { capabilities: { tools: { listChanged: true } } });
        const client = new Client({ name: 'test-client', version: '1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() =>
            server.registerTool('echo', {}, async () => ({
                content: [{ type: 'text', text: 'tool registered after connect' }]
            }))
        ).not.toThrow();

        const result = await client.callTool({ name: 'echo' });
        expect(result.content).toEqual([{ type: 'text', text: 'tool registered after connect' }]);
    });

    test('registers a resource after connect when capabilities.resources is pre-declared', async () => {
        const server = new McpServer({ name: 'test-server', version: '1.0' }, { capabilities: { resources: { listChanged: true } } });
        const client = new Client({ name: 'test-client', version: '1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() =>
            server.registerResource('settings', 'test://settings', {}, async () => ({
                contents: [{ uri: 'test://settings', text: 'resource registered after connect' }]
            }))
        ).not.toThrow();

        const result = await client.readResource({ uri: 'test://settings' });
        expect(result.contents).toEqual([{ uri: 'test://settings', text: 'resource registered after connect' }]);
    });

    test('registers a prompt after connect when capabilities.prompts is pre-declared', async () => {
        const server = new McpServer({ name: 'test-server', version: '1.0' }, { capabilities: { prompts: { listChanged: true } } });
        const client = new Client({ name: 'test-client', version: '1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() =>
            server.registerPrompt('review', {}, async () => ({
                messages: [
                    {
                        role: 'assistant',
                        content: { type: 'text', text: 'prompt registered after connect' }
                    }
                ]
            }))
        ).not.toThrow();

        const result = await client.request({
            method: 'prompts/get',
            params: { name: 'review' }
        });
        expect(result.messages).toEqual([
            {
                role: 'assistant',
                content: { type: 'text', text: 'prompt registered after connect' }
            }
        ]);
    });

    test('registers a completable prompt after connect when capabilities.prompts is pre-declared', async () => {
        const server = new McpServer(
            { name: 'test-server', version: '1.0' },
            { capabilities: { prompts: { listChanged: true }, completions: {} } }
        );
        const client = new Client({ name: 'test-client', version: '1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() =>
            server.registerPrompt(
                'review-with-completion',
                {
                    argsSchema: z.object({
                        tone: completable(z.string(), () => ['direct', 'formal'])
                    })
                },
                async ({ tone }) => ({
                    messages: [
                        {
                            role: 'assistant',
                            content: { type: 'text', text: `tone=${tone}` }
                        }
                    ]
                })
            )
        ).not.toThrow();

        const result = await client.request({
            method: 'completion/complete',
            params: {
                ref: {
                    type: 'ref/prompt',
                    name: 'review-with-completion'
                },
                argument: {
                    name: 'tone',
                    value: ''
                }
            }
        });

        expect(result.completion.values).toEqual(['direct', 'formal']);
        expect(result.completion.total).toBe(2);
    });

    test('registers a completable resource template after connect when capabilities.resources is pre-declared', async () => {
        const server = new McpServer(
            { name: 'test-server', version: '1.0' },
            { capabilities: { resources: { listChanged: true }, completions: {} } }
        );
        const client = new Client({ name: 'test-client', version: '1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        expect(() =>
            server.registerResource(
                'repo',
                new ResourceTemplate('test://repos/{name}', {
                    complete: {
                        name: () => ['alpha', 'beta']
                    }
                }),
                {},
                async () => ({
                    contents: [{ uri: 'test://repos/alpha', text: 'resource registered after connect' }]
                })
            )
        ).not.toThrow();

        const result = await client.request({
            method: 'completion/complete',
            params: {
                ref: {
                    type: 'ref/resource',
                    uri: 'test://repos/{name}'
                },
                argument: {
                    name: 'name',
                    value: ''
                }
            }
        });

        expect(result.completion.values).toEqual(['alpha', 'beta']);
        expect(result.completion.total).toBe(2);
    });
});
