/**
 * Multi-server MCP chatbot.
 *
 * Demonstrates how a single Anthropic-powered chatbot connects to multiple MCP
 * servers simultaneously and routes each tool call to the correct server.
 *
 * Architecture:
 *   Client ──► Map<toolName, Client> ──► weather-server (:3001) or math-server (:3002)
 *
 * Two servers must be running before starting the chatbot:
 *   Terminal 1: pnpm --filter @modelcontextprotocol/examples-server exec tsx src/weatherServer.ts
 *   Terminal 2: pnpm --filter @modelcontextprotocol/examples-server exec tsx src/mathServer.ts
 *
 * Run the chatbot:
 *   ANTHROPIC_API_KEY=sk-... \
 *     pnpm --filter @modelcontextprotocol/examples-client exec tsx src/multiServerChatbot.ts
 *
 * Example prompts:
 *   "What's the weather in Tokyo?"
 *   "What is 17 × 19?"
 *   "Convert 100°C to Fahrenheit and give me a 3-day forecast for Paris."
 *
 * Closes #740
 */

import { createInterface } from 'node:readline';

import Anthropic from '@anthropic-ai/sdk';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MODEL = 'claude-opus-4-5';

const SERVER_CONFIGS = [
    { url: 'http://localhost:3001/mcp', label: 'weather-server', file: 'weatherServer.ts' },
    { url: 'http://localhost:3002/mcp', label: 'math-server', file: 'mathServer.ts' }
] as const;

async function main(): Promise<void> {
    // --- Validate API key ---
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.error('Error: ANTHROPIC_API_KEY is not set.');
        console.error('  export ANTHROPIC_API_KEY=sk-...');
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }

    const anthropic = new Anthropic({ apiKey });

    // --- Connect to all servers ---
    const clients: Client[] = [];

    for (const { url, label, file } of SERVER_CONFIGS) {
        const client = new Client({ name: 'multi-server-chatbot', version: '1.0.0' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(url)));
            clients.push(client);
        } catch {
            console.error(`\nFailed to connect to ${label} at ${url}.`);
            console.error('Is the server running? Start it with:');
            console.error(`  pnpm --filter @modelcontextprotocol/examples-server exec tsx src/${file}`);
            await Promise.all(clients.map(c => c.close()));
            // eslint-disable-next-line unicorn/no-process-exit
            process.exit(1);
        }
    }

    // --- Build routing table and aggregate tool list ---
    // toolRouter maps each tool name to the client that owns it so tool calls
    // can be dispatched to the right server without any manual bookkeeping.
    const toolRouter = new Map<string, Client>();
    const allTools: Anthropic.Tool[] = [];

    for (const [i, client] of clients.entries()) {
        const { tools } = await client.listTools();
        const { label } = SERVER_CONFIGS[i]!;

        for (const tool of tools) {
            if (toolRouter.has(tool.name)) {
                console.warn(`[warning] tool "${tool.name}" is on multiple servers — ${label} will be used`);
            }
            toolRouter.set(tool.name, client);
            allTools.push({
                name: tool.name,
                description: tool.description ?? '',
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
            });
        }
    }

    console.log(`\nConnected to ${clients.length} MCP servers.`);
    console.log(`Tools available: ${allTools.map(t => t.name).join(', ')}`);
    console.log('Type your question or "quit" to exit.\n');

    // --- Clean shutdown ---
    const shutdown = async () => {
        console.log('\nShutting down...');
        await Promise.all(clients.map(c => c.close()));
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0);
    };

    process.on('SIGINT', () => {
        shutdown().catch(console.error);
    });

    // --- readline interface ---
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = (): Promise<string> => new Promise(resolve => rl.question('You: ', resolve));

    // --- Chat loop ---
    while (true) {
        const rawInput = await prompt();
        const userInput = rawInput.trim();

        if (!userInput) continue;
        if (userInput.toLowerCase() === 'quit' || userInput.toLowerCase() === 'exit') break;

        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userInput }];

        // Agentic loop: keep going until the model stops requesting tool calls.
        while (true) {
            const response = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 4096,
                tools: allTools,
                messages
            });

            if (response.stop_reason !== 'tool_use') {
                // No tool calls — print the final text response.
                const text = response.content
                    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                    .map(b => b.text)
                    .join('');
                console.log(`\nAssistant: ${text}\n`);
                break;
            }

            // Execute all tool calls in parallel, each routed to the correct server.
            const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

            const toolResultContent = await Promise.all(
                toolUseBlocks.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
                    const client = toolRouter.get(block.name);
                    if (!client) {
                        return {
                            type: 'tool_result',
                            tool_use_id: block.id,
                            content: `Unknown tool: ${block.name}`,
                            is_error: true
                        };
                    }

                    console.log(`  [tool] ${block.name}(${JSON.stringify(block.input)})`);

                    const result = await client.callTool({
                        name: block.name,
                        arguments: block.input as Record<string, unknown>
                    });

                    const text = result.content
                        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                        .map(c => c.text)
                        .join('\n');

                    console.log(`  [result] ${text}`);
                    return { type: 'tool_result', tool_use_id: block.id, content: text };
                })
            );

            // Append this assistant turn and all tool results, then loop.
            messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: toolResultContent });
        }
    }

    rl.close();
    await Promise.all(clients.map(c => c.close()));
}

try {
    await main();
} catch (error) {
    console.error('Error:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
