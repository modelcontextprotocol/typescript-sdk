import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMClient } from '../src/simpleChatbot.js';
import { ChatSession, connectToAllServers, connectToServer, loadConfig } from '../src/simpleChatbot.js';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const cleanup = (clients: Client[]) => {
    return Promise.all(
        clients.map(async client => {
            try {
                await client.transport?.close();
            } catch {
                console.warn('Error closing client transport');
            }
        })
    );
};
/**
 * Integration tests for simpleChatbot functions and ChatSession class
 */
describe('simpleChatbot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('loadConfig', () => {
        it('should load configuration from a JSON file', async () => {
            const configPath = join(__dirname, '..', 'servers_config.json');
            const config = await loadConfig(configPath);
            expect(config).toHaveProperty('mcpServers');
        });
    });

    describe('ChatSession', () => {
        let mockLlmClient: LLMClient;
        let mcpClients: Map<string, Client>;

        beforeEach(async () => {
            mockLlmClient = {
                getResponse: vi.fn().mockResolvedValue('Mock response')
            };
            const configPath = join(__dirname, '..', 'servers_config.json');
            const config = await loadConfig(configPath);

            mcpClients = await connectToAllServers(config);
        });

        afterEach(async () => {
            // Clean up all connections
            if (mcpClients) {
                await cleanup(Array.from(mcpClients.values()));
            }
        });

        describe('constructor', () => {
            it('should construct with provided clients and llm client', () => {
                const session = new ChatSession(mcpClients, mockLlmClient);
                expect(session).toBeDefined();
                expect(session.clients).toBe(mcpClients);
                expect(session.llmClient).toBe(mockLlmClient);
            });
        });

        describe('getAvailableTools', () => {
            it('should aggregate tools from all servers with server names', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);
                const availableTools = await session.getAvailableTools();
                expect(availableTools.length).toBeGreaterThan(0); // server-everything and server-memory provide tools
                const toolNames = availableTools.map(tool => tool.name);
                // server-everything provides many tools, just verify we get some
                expect(toolNames.length).toBeGreaterThan(0);
            });
        });

        describe('processLlmResponse', () => {
            it('Should detect if LLM wants to call a tool, and execute it', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);

                // Get an actual tool from the connected servers
                const availableTools = await session.getAvailableTools();
                expect(availableTools.length).toBeGreaterThan(0);

                // Use echo tool which we know is from server-everything
                const echoTool = availableTools.find(t => t.name === 'echo');
                expect(echoTool).toBeDefined();

                // Simulate processing llm response that requests a tool call with proper arguments
                const toolCallResponse = JSON.stringify({ tool: 'echo', arguments: { message: 'test message' } });
                const result = await session.processLlmResponse(toolCallResponse);
                expect(result).toContain('Tool execution result');
                expect(result).toContain('test message');
            });
            it('should return response if no tool invocation is needed', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);
                const llmResponse = 'This is a simple response.';
                const result = await session.processLlmResponse(llmResponse);
                expect(result).toBe(llmResponse);
            });
        });

        describe('cleanup', () => {
            it('should close all server connections', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);

                // Create spies on all transports
                const closeSpies = Array.from(mcpClients.values()).map(client => vi.spyOn(client.transport!, 'close'));

                // Verify none have been called yet
                closeSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());

                // Cleanup - may throw connection closed error which is expected
                await session.cleanup().catch(() => {
                    // Expected: transports may error on close
                });

                // Verify all transports were closed
                closeSpies.forEach(spy => expect(spy).toHaveBeenCalledOnce());
            });
        });

        describe('getMessages', () => {
            it('should return empty array initially', () => {
                const session = new ChatSession(mcpClients, mockLlmClient);
                const messages = session.getMessages();
                expect(messages).toEqual([]);
                expect(messages.length).toBe(0);
            });

            it('should return copy of messages', () => {
                const session = new ChatSession(mcpClients, mockLlmClient);
                session.messages.push({ role: 'user', content: 'test' });

                const messages = session.getMessages();
                expect(messages).toEqual([{ role: 'user', content: 'test' }]);

                // Verify it's a copy by modifying and checking original
                messages.push({ role: 'assistant', content: 'response' });
                expect(session.messages.length).toBe(1);
                expect(messages.length).toBe(2);
            });
        });

        describe('start', () => {
            it('should handle interactive chat session with user input', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);

                // Mock readline interface (Promise-based from readline/promises)
                const mockRl = {
                    question: vi.fn(),
                    close: vi.fn()
                };

                // Simulate user inputs: one message then exit
                mockRl.question.mockResolvedValueOnce('Hello, assistant!').mockResolvedValueOnce('exit');

                await session.start(mockRl as any);

                // Verify messages were added
                const messages = session.getMessages();
                expect(messages.length).toBeGreaterThanOrEqual(3); // system + user + assistant
                expect(messages.some(m => m.role === 'user' && m.content === 'Hello, assistant!')).toBe(true);
                expect(messages.some(m => m.role === 'assistant')).toBe(true);
                expect(mockLlmClient.getResponse).toHaveBeenCalled();
            });

            it('should handle tool call during chat session', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);

                // Get an actual tool from the connected servers
                const availableTools = await session.getAvailableTools();
                const echoTool = availableTools.find(t => t.name === 'echo');
                expect(echoTool).toBeDefined();

                // Mock LLM to return tool call request with proper arguments
                (mockLlmClient.getResponse as any).mockResolvedValueOnce(JSON.stringify({ tool: 'echo', arguments: { message: 'test' } }));

                const mockRl = {
                    question: vi.fn(),
                    close: vi.fn()
                };

                mockRl.question.mockResolvedValueOnce('Use a tool').mockResolvedValueOnce('exit');

                await session.start(mockRl as any);

                const messages = session.getMessages();
                // Tool result should be in a system message after the assistant's tool call
                const toolResponse = messages.find(m => m.role === 'system' && m.content.includes('Tool execution result'));
                expect(toolResponse).toBeDefined();
                expect(toolResponse?.content).toContain('test');
            });
        });
    });
});
