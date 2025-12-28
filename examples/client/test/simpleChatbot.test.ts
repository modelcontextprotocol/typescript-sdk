import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';


import { ChatSession, connectToAllServers, connectToServer, loadConfig } from '../src/simpleChatbot.js';
import type { ChatMessage, LLMClient } from '../src/simpleChatbot.js';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const cleanup = (clients: Client[]) => {
    return Promise.all(clients.map(async client => {
        try {
            await client.transport?.close();
        } catch { console.warn('Error closing client transport') }
    }));
}
/**
 * Integration tests for simpleChatbot functions and ChatSession class
 */
describe('simpleChatbot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('loadConfig', () => {
        it('should load configuration from a JSON file', async () => {
            const configPath = join(__dirname, 'fixtures', 'test-mcp-config.json');
            const config = await loadConfig(configPath);
            expect(config).toHaveProperty('mcpServers');
            expect(config).toHaveProperty('llmApiKey');
        });
    });

    describe('connectToServer', () => {
        it('should connect to a single STDIO server', async () => {
            const serverConfig = {
                command: 'node',
                args: [join(__dirname, 'fixtures', 'fake-mcp-server.js')]
            };

            const client = await connectToServer("test-server", serverConfig);
            expect(client).toBeDefined();
            await cleanup([client]);
        });

        it('should handle connection errors', async () => {
            const invalidConfig = {
                command: 'nonexistent-command'
            };
            await expect(
                connectToServer("invalid-server", invalidConfig)
            ).rejects.toThrow();
        });
    });

    describe('connectToAllServers', () => {
        it('should connect to multiple servers in parallel', async () => {
            const configPath = join(__dirname, 'fixtures', 'multi-server-config.json');
            const config = await loadConfig(configPath);

            const clients = await connectToAllServers(config);

            // Verify we got a Map with the correct number of clients
            expect(clients).toBeInstanceOf(Map);
            expect(clients.size).toBe(3);

            // Verify each client is connected
            expect(clients.get('server-1')).toBeDefined();
            expect(clients.get('server-2')).toBeDefined();
            expect(clients.get('server-3')).toBeDefined();
            await cleanup(Array.from(clients.values()));
        });
    });

    describe('ChatSession', () => {
        let mockLlmClient: LLMClient;
        let mcpClients: Map<string, Client>;

        beforeEach(async () => {
            mockLlmClient = {
                getResponse: vi.fn().mockResolvedValue('Mock response')
            };
            const configPath = join(__dirname, 'fixtures', 'multi-server-config.json');
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
                expect(availableTools.length).toEqual(3); // Based on the fake-mcp-server fixtures
                const toolNames = availableTools.map(tool => tool.name);
                expect(toolNames).toContain('ping');
            });
        });

        describe('processLlmResponse', () => {
            it('Should detect if LLM wants to call a tool, and execute it', async () => {
                const session = new ChatSession(mcpClients, mockLlmClient);

                // Simulate processing llm response that requests a tool call
                const toolCallResponse = JSON.stringify({ tool: 'ping', arguments: { message: 'hello' } });
                const result = await session.processLlmResponse(toolCallResponse);
                expect(result).toContain('Tool execution result');
                expect(result).toContain('pong: hello');
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
                const closeSpies = Array.from(mcpClients.values()).map(client =>
                    vi.spyOn(client.transport!, 'close')
                );

                // Verify none have been called yet
                closeSpies.forEach(spy => expect(spy).not.toHaveBeenCalled());

                // Cleanup
                await session.cleanup();

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
                mockRl.question
                    .mockResolvedValueOnce('Hello, assistant!')
                    .mockResolvedValueOnce('exit');

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

                // Mock LLM to return tool call request
                (mockLlmClient.getResponse as any).mockResolvedValueOnce(
                    JSON.stringify({ tool: 'ping', arguments: { message: 'test' } })
                );

                const mockRl = {
                    question: vi.fn(),
                    close: vi.fn()
                };

                mockRl.question
                    .mockResolvedValueOnce('Use the ping tool')
                    .mockResolvedValueOnce('exit');

                await session.start(mockRl as any);

                const messages = session.getMessages();
                // Tool result should be in a system message after the assistant's tool call
                const toolResponse = messages.find(m => m.role === 'system' && m.content.includes('Tool execution result'));
                expect(toolResponse).toBeDefined();
                expect(toolResponse?.content).toContain('pong: test');
            });
        });
    });
});
