/*
    This example demonstrates a lightweight callable wrapper for MCP tools.

    Usage:
      npx -y tsx src/examples/client/callables.ts \
        echo \
        '{"message": "Heya"}' \
        npx -y --silent @modelcontextprotocol/server-everything

    Note: inspect the tools available using:
      npx -y @modelcontextprotocol/inspector npx -- -y --silent @modelcontextprotocol/server-everything

*/

import { StdioClientTransport } from '../../client/stdio.js';
import {
    CallToolResult,
    Tool,
    ListToolsResult,
    CallToolResultSchema,
    ToolListChangedNotificationSchema,
} from "../../types.js";
import { Client } from "src/client/index.js";
import { RequestOptions } from "src/shared/protocol.js";

class CallableTool {
    constructor(private tool: Tool, private client: Client) {}

    async call(input: Record<string, unknown>, options?: RequestOptions) {
        // Server validates input, client validates output automatically
        return await this.client.callTool(
            { name: this.tool.name, arguments: input },
            CallToolResultSchema,
            options
        );
    }

    // Expose tool metadata for reference
    get name() { return this.tool.name; }
    get description() { return this.tool.description; }
    get inputSchema() { return this.tool.inputSchema; }
    get outputSchema() { return this.tool.outputSchema; }
}

export class CallableTools {
    private cache = new Map<string, CallableTool | undefined>();
    private results: Promise<ListToolsResult>[] = [];

    constructor(private client: Client) {}

    notifyToolListChanged() {
        this.results = [];
        this.cache.clear();
    }

    async find(name: string): Promise<CallableTool | undefined> {
        if (this.cache.has(name)) {
            return this.cache.get(name);
        }

        const getCursor = async () => this.results.length > 0 ? (await this.results[this.results.length - 1])?.nextCursor : undefined;
        const fetchNext = (cursor?: string) => this.client.listTools({ cursor });

        for (const result of this.results) {
            const tool = (await result).tools.find(t => t.name === name);
            if (tool) {
                const callable = new CallableTool(tool, this.client);
                this.cache.set(name, callable);
                return callable;
            }
        }

        let cursor: string | undefined;
        while (this.results.length == 0 || (cursor = await getCursor()) !== undefined) {
            const result = fetchNext(cursor);
            this.results.push(result);
            const tool = (await result).tools.find(t => t.name === name);
            if (tool) {
                const callable = new CallableTool(tool, this.client);
                this.cache.set(name, callable);
                return callable;
            }
        }

        this.cache.set(name, undefined);
        return undefined;
    }
}

async function main() {
    const client = new Client({
        name: 'Callables Client',
        version: '0.1.0',
    });
    
    const callables = new CallableTools(client);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => callables.notifyToolListChanged());

    const [toolName, toolArgs, command, ...args] = process.argv.slice(2);
    const transport = new StdioClientTransport({command, args});
    await client.connect(transport);
    
    const tool = await callables.find(toolName);
    if (!tool) {
        console.error(`[callables]: Tool ${toolName} not found`);
        process.exit(1);
    }
    console.log(await tool?.call(JSON.parse(toolArgs)));
}

main().catch((error) => {
    console.error("[callables]: Fatal error:", error);
    process.exit(1);
});
