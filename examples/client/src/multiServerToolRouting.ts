import readline from 'node:readline/promises';

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * Multi-server Tool Routing Example
 *
 * This client demonstrates how to:
 * 1. Connect to multiple Streamable HTTP MCP servers
 * 2. Discover tools from each server
 * 3. Keep a registry of { serverName, client, tools }
 * 4. Route selected tool calls back to the client that owns the tool
 */

const args = process.argv.slice(2);

interface ServerRegistryEntry {
    serverName: string;
    serverUrl: URL;
    client: Client;
    transport: StreamableHTTPClientTransport;
    tools: Tool[];
}

interface RoutedToolCall {
    name: string;
    arguments?: Record<string, unknown>;
}

class MultiServerToolRouter {
    private readonly servers = new Map<string, ServerRegistryEntry>();
    private readonly toolToServer = new Map<string, ServerRegistryEntry>();

    async connect(serverUrls: URL[]): Promise<void> {
        for (const [index, serverUrl] of serverUrls.entries()) {
            const serverName = `server-${index + 1}`;
            const client = new Client({
                name: `multi-server-router-${serverName}`,
                version: '1.0.0'
            });
            const transport = new StreamableHTTPClientTransport(serverUrl);

            client.onerror = error => {
                console.error(`[${serverName}] Client error:`, error);
            };

            client.setNotificationHandler('notifications/message', notification => {
                console.log(`[${serverName}] Notification: ${notification.params.data}`);
            });

            console.log(`[${serverName}] Connecting to ${serverUrl.href}`);
            await client.connect(transport);

            const { tools } = await client.listTools();
            const entry: ServerRegistryEntry = {
                serverName,
                serverUrl,
                client,
                transport,
                tools
            };

            this.registerServerTools(entry);
            this.servers.set(serverName, entry);

            console.log(`[${serverName}] Connected with tools: ${tools.map(tool => tool.name).join(', ') || '(none)'}`);
        }
    }

    listTools(): void {
        console.log('\n=== Available tools ===');
        for (const { serverName, serverUrl, tools } of this.servers.values()) {
            console.log(`\n[${serverName}] ${serverUrl.href}`);
            if (tools.length === 0) {
                console.log('  (no tools)');
                continue;
            }

            for (const tool of tools) {
                console.log(`  - ${tool.name}${tool.description ? `: ${tool.description}` : ''}`);
            }
        }
    }

    async routeToolCall(toolCall: RoutedToolCall): Promise<CallToolResult> {
        const server = this.toolToServer.get(toolCall.name);
        if (!server) {
            throw new Error(`Unknown tool "${toolCall.name}". Run "tools" to see available tools.`);
        }

        console.log(`[${server.serverName}] Routing tool call: ${toolCall.name}`);
        return server.client.callTool({
            name: toolCall.name,
            arguments: toolCall.arguments
        });
    }

    async close(): Promise<void> {
        await Promise.allSettled(
            Array.from(this.servers.values(), async ({ serverName, transport }) => {
                await transport.close();
                console.log(`[${serverName}] Disconnected`);
            })
        );
    }

    private registerServerTools(entry: ServerRegistryEntry): void {
        for (const tool of entry.tools) {
            const existingServer = this.toolToServer.get(tool.name);
            if (existingServer) {
                throw new Error(
                    `Tool name "${tool.name}" is exposed by both ${existingServer.serverName} ` +
                        `and ${entry.serverName}. Rename one of the tools before routing tool calls.`
                );
            }

            this.toolToServer.set(tool.name, entry);
        }
    }
}

function parseServerUrls(rawUrls: string[]): URL[] {
    if (rawUrls.length === 0) {
        console.log(
            'Usage: pnpm --filter @modelcontextprotocol/examples-client exec tsx ' +
                'src/multiServerToolRouting.ts <server_url> [more_server_urls...]'
        );
        console.log(
            'Example: pnpm --filter @modelcontextprotocol/examples-client exec tsx ' +
                'src/multiServerToolRouting.ts http://localhost:3000/mcp http://localhost:3001/mcp'
        );
        return [];
    }

    return rawUrls.map(rawUrl => new URL(rawUrl));
}

function parseToolArguments(input: string): Record<string, unknown> | undefined {
    if (!input.trim()) {
        return undefined;
    }

    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Tool arguments must be a JSON object.');
    }

    return parsed as Record<string, unknown>;
}

function printToolResult(result: CallToolResult): void {
    console.log('\n=== Tool result ===');
    for (const item of result.content) {
        if (item.type === 'text') {
            console.log(item.text);
        } else {
            console.log(`${item.type} content:`, item);
        }
    }
}

async function runInteractiveLoop(router: MultiServerToolRouter): Promise<void> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        router.listTools();
        console.log('\nType a tool name to call it, "tools" to list tools, or "quit" to exit.');

        while (true) {
            const rawToolName = await rl.question('\nTool: ');
            const toolName = rawToolName.trim();
            if (toolName.toLowerCase() === 'quit') {
                break;
            }

            if (toolName.toLowerCase() === 'tools') {
                router.listTools();
                continue;
            }

            const rawArgs = await rl.question('Arguments as JSON object (blank for none): ');
            const result = await router.routeToolCall({
                name: toolName,
                arguments: parseToolArguments(rawArgs)
            });
            printToolResult(result);
        }
    } finally {
        rl.close();
    }
}

async function main(): Promise<void> {
    const serverUrls = parseServerUrls(args);
    if (serverUrls.length === 0) {
        return;
    }

    const router = new MultiServerToolRouter();
    try {
        await router.connect(serverUrls);
        await runInteractiveLoop(router);
    } finally {
        await router.close();
    }
}

try {
    await main();
} catch (error) {
    console.error('Error running multi-server tool router:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
