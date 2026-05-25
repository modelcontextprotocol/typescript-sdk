import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

interface ServerConfig {
    name: string;
    url: string;
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface ToolEntry {
    serverName: string;
    tool: Tool;
    client: Client;
}

interface ToolCall {
    tool: string;
    arguments?: Record<string, unknown>;
}

const servers: ServerConfig[] = parseServers(process.env.MCP_SERVER_URLS);
const apiKey = process.env.LLM_API_KEY;
const llmBaseUrl = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1';
const llmModel = process.env.LLM_MODEL ?? 'gpt-4.1-mini';

function parseServers(value: string | undefined): ServerConfig[] {
    if (!value) {
        return [
            {
                name: 'local',
                url: 'http://localhost:3000/mcp'
            }
        ];
    }

    return value.split(',').map((entry, index) => {
        const parts = entry.includes('=') ? entry.split('=', 2) : [`server${index + 1}`, entry];
        const name = parts[0] ?? `server${index + 1}`;
        const url = parts[1] ?? entry;

        return {
            name: name.trim(),
            url: url.trim()
        };
    });
}

async function connectServers(configs: ServerConfig[]): Promise<ToolEntry[]> {
    const entries: ToolEntry[] = [];

    await Promise.all(
        configs.map(async config => {
            const client = new Client({
                name: `multi-server-chatbot-${config.name}`,
                version: '1.0.0'
            });

            const transport = new StreamableHTTPClientTransport(new URL(config.url));
            await client.connect(transport);

            const { tools } = await client.listTools();
            for (const tool of tools) {
                entries.push({
                    serverName: config.name,
                    tool,
                    client
                });
            }

            console.log(`Connected to ${config.name} (${config.url}) with ${tools.length} tools`);
        })
    );

    return entries;
}

function formatTool(entry: ToolEntry): string {
    const exposedName = `${entry.serverName}::${entry.tool.name}`;
    const properties = entry.tool.inputSchema.properties ?? {};
    const required = new Set(entry.tool.inputSchema.required);
    const parameters = Object.entries(properties)
        .map(([name, schema]) => `- ${name}${required.has(name) ? ' (required)' : ''}: ${JSON.stringify(schema)}`)
        .join('\n');

    return [
        `Tool: ${exposedName}`,
        `Description: ${entry.tool.description ?? 'No description provided.'}`,
        'Arguments:',
        parameters || '- none'
    ].join('\n');
}

function buildSystemPrompt(tools: ToolEntry[]): string {
    return [
        'You are a helpful assistant connected to multiple MCP servers.',
        'If the user asks for something that needs a tool, respond only with a JSON object in this form:',
        '{"tool":"server-name::tool-name","arguments":{"name":"value"}}',
        'If no tool is needed, answer normally.',
        'Available tools:',
        tools.map(entry => formatTool(entry)).join('\n\n')
    ].join('\n\n');
}

async function getLlmResponse(messages: ChatMessage[]): Promise<string> {
    if (!apiKey) {
        throw new Error('Set LLM_API_KEY before running this example.');
    }

    const response = await fetch(`${llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: llmModel,
            messages,
            temperature: 0.2
        })
    });

    if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('LLM response did not include message content.');
    }

    return content;
}

function parseToolCall(response: string): ToolCall | null {
    try {
        const parsed = JSON.parse(response) as Partial<ToolCall>;
        if (typeof parsed.tool === 'string') {
            return {
                tool: parsed.tool,
                arguments: parsed.arguments ?? {}
            };
        }
    } catch {
        return null;
    }

    return null;
}

async function executeTool(toolCall: ToolCall, tools: ToolEntry[]): Promise<CallToolResult> {
    const [serverName, toolName] = toolCall.tool.split('::', 2);
    const entry = tools.find(item => item.serverName === serverName && item.tool.name === toolName);

    if (!entry) {
        throw new Error(`No connected MCP tool found for ${toolCall.tool}`);
    }

    return entry.client.callTool({
        name: entry.tool.name,
        arguments: toolCall.arguments ?? {}
    });
}

function formatToolResult(result: CallToolResult): string {
    const text = result.content.map(item => (item.type === 'text' ? item.text : JSON.stringify(item))).join('\n');

    return [
        result.isError ? 'Tool returned an error.' : 'Tool execution result:',
        text,
        result.structuredContent ? `Structured content: ${JSON.stringify(result.structuredContent)}` : ''
    ]
        .filter(Boolean)
        .join('\n');
}

async function main(): Promise<void> {
    console.log('MCP Multi-Server Chatbot');
    console.log('========================');

    const toolEntries = await connectServers(servers);
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: buildSystemPrompt(toolEntries)
        }
    ];

    const readline = createInterface({ input, output });

    try {
        while (true) {
            const userInput = await readline.question('\nYou: ');
            if (['exit', 'quit'].includes(userInput.trim().toLowerCase())) {
                break;
            }

            messages.push({ role: 'user', content: userInput });
            const firstResponse = await getLlmResponse(messages);
            const toolCall = parseToolCall(firstResponse);

            if (!toolCall) {
                console.log(`\nAssistant: ${firstResponse}`);
                messages.push({ role: 'assistant', content: firstResponse });
                continue;
            }

            console.log(`\nCalling ${toolCall.tool}...`);
            const toolResult = await executeTool(toolCall, toolEntries);
            const toolMessage = formatToolResult(toolResult);

            messages.push({ role: 'assistant', content: firstResponse }, { role: 'user', content: toolMessage });

            const finalResponse = await getLlmResponse(messages);
            console.log(`\nAssistant: ${finalResponse}`);
            messages.push({ role: 'assistant', content: finalResponse });
        }
    } finally {
        readline.close();
    }
}

try {
    await main();
} catch (error) {
    console.error(error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
