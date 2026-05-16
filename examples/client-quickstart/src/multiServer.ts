import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import readline from 'readline/promises';

import {
    buildQualifiedToolDefinitions,
    createUniqueServerLabel
} from './multiServerHelpers.js';

const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

type ConnectedServer = {
    client: Client;
    label: string;
    scriptPath: string;
};

type ToolBinding = {
    client: Client;
    originalToolName: string;
    qualifiedToolName: string;
    serverLabel: string;
};

class MultiServerMCPClient {
    private readonly servers: ConnectedServer[] = [];
    private readonly toolBindings = new Map<string, ToolBinding>();
    private readonly tools: Anthropic.Tool[] = [];
    private _anthropic: Anthropic | null = null;

    private get anthropic(): Anthropic {
        return this._anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    async connectToServers(serverScriptPaths: string[]): Promise<void> {
        const usedLabels = new Set<string>();

        for (const serverScriptPath of serverScriptPaths) {
            const label = createUniqueServerLabel(serverScriptPath, usedLabels);
            const client = await this.connectSingleServer(label, serverScriptPath);
            this.servers.push({ client, label, scriptPath: serverScriptPath });

            const toolsResult = await client.listTools();
            const qualifiedTools = buildQualifiedToolDefinitions(label, toolsResult.tools);

            for (const tool of qualifiedTools) {
                this.tools.push(tool.anthropicTool);
                this.toolBindings.set(tool.qualifiedToolName, {
                    client,
                    originalToolName: tool.originalToolName,
                    qualifiedToolName: tool.qualifiedToolName,
                    serverLabel: label
                });
            }

            console.log(
                `Connected ${label} with tools: ${qualifiedTools.map((tool) => tool.qualifiedToolName).join(', ')}`
            );
        }
    }

    private async connectSingleServer(label: string, serverScriptPath: string): Promise<Client> {
        const isJs = serverScriptPath.endsWith('.js');
        const isPy = serverScriptPath.endsWith('.py');

        if (!isJs && !isPy) {
            throw new Error(`Server script must be a .js or .py file: ${serverScriptPath}`);
        }

        const command = isPy
            ? process.platform === 'win32'
                ? 'python'
                : 'python3'
            : process.execPath;

        const client = new Client({
            name: `mcp-client-cli-${label}`,
            version: '1.0.0'
        });
        const transport = new StdioClientTransport({ command, args: [serverScriptPath] });

        await client.connect(transport);
        return client;
    }

    async processQuery(query: string): Promise<string> {
        const messages: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content: query
            }
        ];

        const response = await this.anthropic.messages.create({
            model: ANTHROPIC_MODEL,
            max_tokens: 1000,
            messages,
            tools: this.tools
        });

        const finalText: string[] = [];

        for (const content of response.content) {
            if (content.type === 'text') {
                finalText.push(content.text);
                continue;
            }

            if (content.type !== 'tool_use') {
                continue;
            }

            const binding = this.toolBindings.get(content.name);
            if (!binding) {
                throw new Error(`Unknown qualified tool name: ${content.name}`);
            }

            const toolArgs = content.input as Record<string, unknown> | undefined;
            const result = await binding.client.callTool({
                name: binding.originalToolName,
                arguments: toolArgs
            });

            finalText.push(
                `[Calling ${binding.originalToolName} on ${binding.serverLabel} with args ${JSON.stringify(toolArgs)}]`
            );

            const toolResultText = result.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');

            messages.push({
                role: 'assistant',
                content: response.content
            });
            messages.push({
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: content.id,
                        content: toolResultText
                    }
                ]
            });

            const followUp = await this.anthropic.messages.create({
                model: ANTHROPIC_MODEL,
                max_tokens: 1000,
                messages
            });

            finalText.push(followUp.content[0]?.type === 'text' ? followUp.content[0].text : '');
        }

        return finalText.join('\n');
    }

    async chatLoop(): Promise<void> {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            console.log('\nMulti-server MCP Client Started!');
            console.log('Type your queries or "quit" to exit.');

            while (true) {
                const message = await rl.question('\nQuery: ');
                if (message.toLowerCase() === 'quit') {
                    break;
                }

                const response = await this.processQuery(message);
                console.log(`\n${response}`);
            }
        } finally {
            rl.close();
        }
    }

    async cleanup(): Promise<void> {
        await Promise.allSettled(this.servers.map(({ client }) => client.close()));
    }
}

async function main(): Promise<void> {
    const serverScriptPaths = process.argv.slice(2);
    if (serverScriptPaths.length === 0) {
        console.log('Usage: node build/multiServer.js <path_to_server_script> [more_paths...]');
        return;
    }

    const mcpClient = new MultiServerMCPClient();
    try {
        await mcpClient.connectToServers(serverScriptPaths);

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            console.log(
                '\nNo ANTHROPIC_API_KEY found. To query these tools with Claude, set your API key:'
                    + '\n  export ANTHROPIC_API_KEY=your-api-key-here'
            );
            return;
        }

        await mcpClient.chatLoop();
    } catch (error) {
        console.error('Error:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    } finally {
        await mcpClient.cleanup();
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0);
    }
}

await main();
