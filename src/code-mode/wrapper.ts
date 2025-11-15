import { McpServer } from '../server/mcp.js';
import type { Transport } from '../shared/transport.js';
import { ErrorCode, McpError, type CallToolResult, type Implementation, type Tool } from '../types.js';
import {
    CallToolInputSchema,
    GetToolImplementationInputSchema,
    GetToolImplementationOutputSchema,
    ListMcpServersOutputSchema,
    type ListMcpServersResult,
    type GetToolImplementationResult,
    ListToolNamesInputSchema,
    ListToolNamesOutputSchema,
    type ListToolNamesResult,
    type ToolSummary
} from './metaTools.js';
import { DefaultDownstreamHandle, type DownstreamConfig, type DownstreamHandle } from './downstream.js';

type DownstreamFactory = (config: DownstreamConfig, clientInfo: Implementation) => DownstreamHandle;

export type CodeModeWrapperOptions = {
    /**
     * Downstream MCP servers that should be exposed through code-mode.
     */
    downstreams: DownstreamConfig[];

    /**
     * Info advertised for the wrapper server itself.
     */
    serverInfo?: Implementation;

    /**
     * Info advertised when the wrapper connects to downstream servers.
     */
    downstreamClientInfo?: Implementation;

    /**
     * Used for testing to override how downstream handles are created.
     */
    downstreamFactory?: DownstreamFactory;
};

const DEFAULT_SERVER_INFO: Implementation = {
    name: 'code-mode-wrapper',
    version: '0.1.0'
};

const DEFAULT_DOWNSTREAM_CLIENT_INFO: Implementation = {
    name: 'code-mode-wrapper-client',
    version: '0.1.0'
};

export class CodeModeWrapper {
    public readonly server: McpServer;

    private readonly _handles: Map<string, DownstreamHandle>;
    private readonly _downstreamFactory: DownstreamFactory;
    private readonly _downstreamClientInfo: Implementation;

    constructor(private readonly _options: CodeModeWrapperOptions) {
        if (!_options.downstreams.length) {
            throw new Error('At least one downstream server must be configured.');
        }

        const serverInfo = _options.serverInfo ?? DEFAULT_SERVER_INFO;
        this.server = new McpServer(serverInfo, {
            capabilities: {
                tools: {}
            }
        });

        this._downstreamClientInfo = _options.downstreamClientInfo ?? DEFAULT_DOWNSTREAM_CLIENT_INFO;
        this._downstreamFactory =
            _options.downstreamFactory ??
            ((config: DownstreamConfig, clientInfo: Implementation) => new DefaultDownstreamHandle(config, clientInfo));

        this._handles = new Map(
            _options.downstreams.map(config => [config.id, this._downstreamFactory(config, this._downstreamClientInfo)])
        );

        this.registerMetaTools();
    }

    async connect(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }

    async close(): Promise<void> {
        await Promise.all([...this._handles.values()].map(handle => handle.close()));
        await this.server.close();
    }

    /**
     * Internal helper exposed for easier testing.
     */
    async listToolSummaries(serverId?: string): Promise<ToolSummary[]> {
        if (!serverId) {
            throw new McpError(ErrorCode.InvalidParams, 'serverId is required');
        }

        const handle = this.getHandle(serverId);
        const tools = await handle.listTools();
        return tools.map(tool => ({
            serverId: handle.config.id,
            toolName: tool.name,
            description: tool.description
        }));
    }

    async listMcpServers(): Promise<ListMcpServersResult['servers']> {
        return this._options.downstreams.map(config => ({
            serverId: config.id,
            description: config.description
        }));
    }

    /**
     * Internal helper exposed for easier testing.
     */
    async getToolImplementationSummary(serverId: string, toolName: string): Promise<GetToolImplementationResult> {
        const handle = this.getHandle(serverId);
        const tool = await handle.getTool(toolName);
        if (!tool) {
            throw new McpError(ErrorCode.InvalidParams, `Tool ${toolName} not found on server ${serverId}`);
        }

        return {
            serverId,
            toolName,
            description: tool.description,
            annotations: tool.annotations,
            inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
            outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
            signature: generateToolSignature(tool)
        };
    }

    /**
     * Internal helper exposed for easier testing.
     */
    async callDownstreamTool(serverId: string, toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
        const handle = this.getHandle(serverId);
        return handle.callTool(toolName, args);
    }

    private registerMetaTools() {
        this.server.registerTool(
            'list_mcp_servers',
            {
                description: 'List the available downstream MCP servers.',
                outputSchema: ListMcpServersOutputSchema
            },
            async () => {
                const servers = await this.listMcpServers();
                const structuredContent: ListMcpServersResult = { servers };
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(structuredContent, null, 2)
                        }
                    ],
                    structuredContent
                };
            }
        );

        this.server.registerTool(
            'list_tool_names',
            {
                description: 'List tools exposed by a specific downstream MCP server.',
                inputSchema: ListToolNamesInputSchema,
                outputSchema: ListToolNamesOutputSchema
            },
            async ({ serverId }) => {
                const tools = await this.listToolSummaries(serverId);
                const structuredContent: ListToolNamesResult = { tools };
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(structuredContent, null, 2)
                        }
                    ],
                    structuredContent
                };
            }
        );

        this.server.registerTool(
            'get_tool_implementation',
            {
                description: 'Inspect an individual downstream tool and generate a TypeScript stub.',
                inputSchema: GetToolImplementationInputSchema,
                outputSchema: GetToolImplementationOutputSchema
            },
            async ({ serverId, toolName }) => {
                const structuredContent = await this.getToolImplementationSummary(serverId, toolName);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: structuredContent.signature
                        }
                    ],
                    structuredContent
                };
            }
        );

        this.server.registerTool(
            'call_tool',
            {
                description: 'Invoke a downstream tool directly through the wrapper.',
                inputSchema: CallToolInputSchema
            },
            async ({ serverId, toolName, arguments: args }) => {
                return this.callDownstreamTool(serverId, toolName, args);
            }
        );
    }

    private getHandle(serverId: string): DownstreamHandle {
        const handle = this._handles.get(serverId);
        if (!handle) {
            throw new McpError(ErrorCode.InvalidParams, `Unknown server: ${serverId}`);
        }

        return handle;
    }
}

function generateToolSignature(tool: Tool): string {
    const lines = [
        `import { Client } from '@modelcontextprotocol/sdk/client';`,
        '',
        tool.description ? `// ${tool.description}` : undefined,
        formatSchemaComment('inputSchema', tool.inputSchema),
        formatSchemaComment('outputSchema', tool.outputSchema),
        `export async function ${sanitizeIdentifier(tool.name)}(client: Client, args?: Record<string, unknown>) {`,
        `  return client.callTool({ name: '${tool.name}', arguments: args });`,
        `}`
    ].filter(Boolean) as string[];

    return lines.join('\n');
}

function formatSchemaComment(label: string, schema: Record<string, unknown> | undefined): string {
    if (!schema) {
        return `// ${label}: none`;
    }

    const serialized = JSON.stringify(schema, null, 2)
        .split('\n')
        .map(line => `// ${line}`)
        .join('\n');

    return `// ${label}:\n${serialized}`;
}

function sanitizeIdentifier(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9_$]/g, '_');
    if (!cleaned.length) {
        return 'tool';
    }

    return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
