import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

import type { Tool } from '@modelcontextprotocol/client';
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

interface ServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface Config {
    mcpServers: Record<string, ServerConfig>;
    llmApiKey: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMClient {
    getResponse(messages: ChatMessage[]): Promise<string>;
}

/**
 * Load configuration from a JSON file
 */
export async function loadConfig(path: string): Promise<Config> {
    const content = await readFile(path, 'utf-8');
    const config = JSON.parse(content) as Config;

    // Validate required fields
    if (!config.mcpServers) {
        throw new Error('Config missing required field: mcpServers');
    }

    return config;
}

/**
 * Connect to a single MCP server via STDIO
 */
export async function connectToServer(name: string, config: ServerConfig): Promise<Client> {
    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
    });

    const client = new Client({
        name: `chatbot-client-${name}`,
        version: '1.0.0'
    });

    await client.connect(transport);
    return client;
}

/**
 * Connect to all MCP servers from config in parallel
 */
export async function connectToAllServers(config: Config): Promise<Map<string, Client>> {
    const entries = Object.entries(config.mcpServers);

    const clients = await Promise.all(
        entries.map(([name, serverConfig]) =>
            connectToServer(name, serverConfig)
        )
    );

    const clientMap = new Map<string, Client>();
    entries.forEach(([name], index) => {
        clientMap.set(name, clients[index]!);
    });

    return clientMap;
}

/**
 * ChatSession orchestrates the interaction between user, LLM, and MCP servers.
 * Handles tool discovery, execution, and maintains conversation state.
 */
export class ChatSession {
    public readonly clients: Map<string, Client>;
    public readonly llmClient: LLMClient;
    public readonly messages: ChatMessage[] = [];

    constructor(clients: Map<string, Client>, llmClient: LLMClient) {
        this.clients = clients;
        this.llmClient = llmClient;
    }

    /**
     * Get all available tools from all connected servers
     */
    async getAvailableTools(): Promise<Array<Tool & { serverName: string }>> {
        throw new Error('Not implemented yet');
    }

    /**
     * Parse LLM response for tool call requests
     */
    private parseToolCallRequest(llmResponse: string): { tool: string; arguments: unknown } | null {
        throw new Error('Not implemented yet');
    }

    /**
     * Process LLM response and execute tool if needed
     */
    async processLlmResponse(llmResponse: string): Promise<string> {
        throw new Error('Not implemented yet');
    }

    /**
     * Build system prompt with available tools
     */
    private async buildSystemPrompt(): Promise<string> {
        throw new Error('Not implemented yet');
    }

    /**
     * Clean up all server connections
     */
    async cleanup(): Promise<void> {
        throw new Error('Not implemented yet');
    }

    /**
     * Start interactive chat session
     */
    async start(): Promise<void> {
        throw new Error('Not implemented yet');
    }

    /**
     * Get current message history
     */
    getMessages(): ChatMessage[] {
        return [...this.messages];
    }
}

export async function main(): Promise<void> {
    // TODO: Implement main orchestration
    // Example:
    // const config = await loadConfig('./config.json');
    // const clients = await connectToAllServers(config);
    // const llmClient = new YourLLMClient(config.llmApiKey);
    // const session = new ChatSession(clients, llmClient);
    // await session.start();
}