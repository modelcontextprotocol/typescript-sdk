import { readFile } from 'node:fs/promises';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
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

    const clients = await Promise.all(entries.map(([name, serverConfig]) => connectToServer(name, serverConfig)));

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
    public messages: ChatMessage[] = [];

    constructor(clients: Map<string, Client>, llmClient: LLMClient) {
        this.clients = clients;
        this.llmClient = llmClient;
    }

    /**
     * Get all available tools from all connected servers
     */
    async getAvailableTools(): Promise<Array<Tool & { serverName: string }>> {
        const allTools: Array<Tool & { serverName: string }> = [];

        for (const [serverName, client] of this.clients.entries()) {
            const response = await client.listTools();
            for (const tool of response.tools) {
                allTools.push({ ...tool, serverName });
            }
        }

        return allTools;
    }

    /**
     * Parse LLM response for tool call requests, returns null if no tool call is requested
     */
    private parseToolCallRequest(llmResponse: string): { tool: string; arguments: unknown } | null {
        try {
            const parsed = JSON.parse(llmResponse);
            if (parsed && typeof parsed === 'object' && 'tool' in parsed && 'arguments' in parsed) {
                return parsed as { tool: string; arguments: unknown };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Process LLM response and execute tool if needed
     */
    async processLlmResponse(llmResponse: string): Promise<string> {
        const parsedToolCall = this.parseToolCallRequest(llmResponse);
        if (parsedToolCall === null) {
            return llmResponse;
        }

        // Find which server has this tool
        for (const client of this.clients.values()) {
            const tools = await client.listTools();
            const hasTool = tools.tools.some(t => t.name === parsedToolCall.tool);

            if (hasTool) {
                try {
                    const result = await client.callTool({
                        name: parsedToolCall.tool,
                        arguments: parsedToolCall.arguments as Record<string, unknown>
                    });

                    return `Tool execution result: ${JSON.stringify(result)}`;
                } catch (e) {
                    const errorMsg = `Error executing tool: ${(e as Error).message}`;
                    console.error(errorMsg);
                    return errorMsg;
                }
            }
        }

        return `No server found with tool: ${parsedToolCall.tool}`;
    }

    /**
     * Build system prompt with available tools
     */
    private async buildSystemPrompt(): Promise<string> {
        const tools = await this.getAvailableTools();
        const toolDescriptions = tools
            .map(tool => `- ${tool.name} (from ${tool.serverName}): ${tool.description || 'No description available'}`)
            .join('\n');

        return `You are a helpful assistant with access to the following tools:\n${toolDescriptions}\n\nWhen you want to use a tool, respond with JSON in this format: {"tool": "tool_name", "arguments": {"arg": "value"}}`;
    }

    /**
     * Clean up all server connections
     */
    async cleanup(): Promise<void> {
        for (const [serverName, client] of this.clients.entries()) {
            if (!client || !client.transport) continue;
            try {
                await client.transport.close();
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                console.warn(`Warning during cleanup of server ${serverName}: ${message}`);
            }
        }
    }

    /**
     * Start interactive chat session
     * @param readlineInterface Optional readline interface for testing
     */
    async start(readlineInterface?: ReadlineInterface): Promise<void> {
        const rl =
            readlineInterface ??
            createInterface({
                input: process.stdin,
                output: process.stdout
            });

        try {
            // Initialize system message
            const systemMessage = await this.buildSystemPrompt();
            this.messages = [{ role: 'system', content: systemMessage }];

            console.log('Chat session started. Type "exit" or "quit" to end.\n');

            // Chat loop
            while (true) {
                let userInput: string;
                try {
                    userInput = (await rl.question('You: ')).trim();
                } catch (err) {
                    console.error('Error reading input:', err);
                    break;
                }

                if (userInput.toLowerCase() === 'quit' || userInput.toLowerCase() === 'exit') {
                    console.log('\nExiting...');
                    break;
                }

                this.messages.push({ role: 'user', content: userInput });

                const llmResponse = await this.llmClient.getResponse(this.messages);
                console.log(`\nAssistant: ${llmResponse}`);

                const result = await this.processLlmResponse(llmResponse);

                if (result !== llmResponse) {
                    // Tool was executed, add both LLM response and tool result
                    this.messages.push({ role: 'assistant', content: llmResponse });
                    this.messages.push({ role: 'system', content: result });

                    // Get final response from LLM
                    const finalResponse = await this.llmClient.getResponse(this.messages);
                    console.log(`\nFinal response: ${finalResponse}`);
                    this.messages.push({ role: 'assistant', content: finalResponse });
                } else {
                    this.messages.push({ role: 'assistant', content: llmResponse });
                }
            }
        } catch (e) {
            console.error('Error during chat session:', e);
        } finally {
            rl.close();
            await this.cleanup();
        }
    }

    /**
     * Get current message history
     */
    getMessages(): ChatMessage[] {
        return [...this.messages];
    }
}

/**
 * Simple LLM client using OpenAI-compatible API
 * Compatible with OpenAI, Groq, and other providers following the OpenAI API format
 */
export class SimpleLLMClient implements LLMClient {
    private readonly apiKey: string;
    private readonly endpoint: string;
    private readonly model: string;

    constructor(apiKey: string, endpoint = 'https://api.openai.com/v1/chat/completions', model = 'gpt-4') {
        this.apiKey = apiKey;
        this.endpoint = endpoint;
        this.model = model;
    }

    async getResponse(messages: ChatMessage[]): Promise<string> {
        const response = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as {
            choices: Array<{ message: { content: string } }>;
        };

        return data.choices[0]?.message?.content || 'No response from LLM';
    }
}

export async function main(): Promise<void> {
    try {
        // Load configuration
        const configPath = process.argv[2] || './servers_config.json';
        console.log(`Loading configuration from ${configPath}...`);
        const config = await loadConfig(configPath);

        // Get API key from environment variable
        const apiKey = process.env.LLM_API_KEY;
        if (!apiKey) {
            throw new Error('LLM_API_KEY environment variable is required');
        }

        // Connect to all MCP servers
        console.log('Connecting to MCP servers...');
        const clients = await connectToAllServers(config);
        console.log(`Connected to ${clients.size} server(s): ${[...clients.keys()].join(', ')}\n`);

        // Initialize LLM client (defaults to OpenAI, can be configured)
        const llmClient = new SimpleLLMClient(apiKey);

        // Start chat session
        const session = new ChatSession(clients, llmClient);
        await session.start();
    } catch (error) {
        console.error('Failed to start chatbot:', error);
        process.exit(1);
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
