import Anthropic from '@anthropic-ai/sdk';
import type { Client } from '@modelcontextprotocol/client';

type ToolLike = {
    name: string;
    description?: string | null;
    inputSchema: unknown;
};

export type RegisteredTool = {
    client: Client;
    tool: Anthropic.Tool;
};

export function registerToolsForClient(
    client: Client,
    tools: ToolLike[],
    toolToClient: Map<string, Client>
): RegisteredTool[] {
    return tools.map((tool) => {
        if (toolToClient.has(tool.name)) {
            throw new Error(
                `Duplicate tool name "${tool.name}" found across MCP servers. `
                    + 'Use servers with unique tool names, or rename tools before exposing them to Claude.'
            );
        }

        toolToClient.set(tool.name, client);

        return {
            client,
            tool: {
                name: tool.name,
                description: tool.description ?? '',
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
            }
        };
    });
}

export function getClientForTool(toolName: string, toolToClient: Map<string, Client>): Client {
    const client = toolToClient.get(toolName);
    if (!client) {
        throw new Error(`No MCP client registered for tool: ${toolName}`);
    }

    return client;
}
