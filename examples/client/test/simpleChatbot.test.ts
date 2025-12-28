import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';


import { ChatSession, connectToAllServers, connectToServer, loadConfig } from '../src/simpleChatbot.js';
import type { ChatMessage, LLMClient } from '../src/simpleChatbot.js';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Unit tests for simpleChatbot
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

            // Clean up - close the transport
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const transport = (client as any)._transport;
            if (transport?.close) {
                await transport.close();
            }
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

            // Clean up all connections
            const closePromises = Array.from(clients.values()).map(client => {
                return client.close();
            });
            await Promise.all(closePromises);
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
            const closePromises = Array.from(mcpClients.values()).map(client => {
                return client.close();
            });
            await Promise.all(closePromises);
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
            it('should return response if no tool invocation is needed', async () => {
                // TODO: Implement test
            });

            it('should execute tool and return result when llm message is tool invocation', async () => {
                // TODO: Implement test
            });

            it('should handle tool execution errors gracefully', async () => {
                // TODO: Implement test
            });

            it('should handle malformed JSON gracefully', async () => {
                // TODO: Implement test
            });
        });

        describe('cleanup', () => {
            it('should cleanup without throwing', async () => {
                // TODO: Implement test
            });

            it('should close all server connections', async () => {
                // TODO: Implement test
            });
        });

        describe('getMessages', () => {
            it('should return empty array initially', () => {
                // TODO: Implement test
            });

            it('should return copy of messages', () => {
                // TODO: Implement test
            });
        });
    });
});
