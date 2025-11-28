import { Client } from '../client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../client/stdio.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '../types.js';
import type { CallToolResult, Implementation, Tool } from '../types.js';

export type DownstreamConfig = {
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    description?: string;
};

export interface DownstreamHandle {
    readonly config: DownstreamConfig;
    listTools(): Promise<Tool[]>;
    getTool(toolName: string): Promise<Tool | undefined>;
    callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>;
    close(): Promise<void>;
}

export class DefaultDownstreamHandle implements DownstreamHandle {
    private readonly _clientInfo: Implementation;
    private _client?: Client;
    private _toolsCache?: Tool[];
    private _listPromise?: Promise<Tool[]>;

    constructor(
        private readonly _config: DownstreamConfig,
        clientInfo: Implementation
    ) {
        this._clientInfo = clientInfo;
    }

    get config(): DownstreamConfig {
        return this._config;
    }

    async listTools(): Promise<Tool[]> {
        if (this._toolsCache) {
            return this._toolsCache;
        }

        if (this._listPromise) {
            return this._listPromise;
        }

        this._listPromise = this._ensureClient()
            .then(async client => {
                const result = await client.listTools();
                this._toolsCache = result.tools;
                return this._toolsCache;
            })
            .finally(() => {
                this._listPromise = undefined;
            });

        return this._listPromise;
    }

    async getTool(toolName: string): Promise<Tool | undefined> {
        const tools = await this.listTools();
        return tools.find(tool => tool.name === toolName);
    }

    async callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
        const client = await this._ensureClient();
        return client.callTool(
            {
                name: toolName,
                arguments: args
            },
            CallToolResultSchema
        ) as Promise<CallToolResult>;
    }

    async close(): Promise<void> {
        await this._client?.close();
        this._client = undefined;
        this._toolsCache = undefined;
    }

    private async _ensureClient(): Promise<Client> {
        if (this._client) {
            return this._client;
        }

        const transport = new StdioClientTransport({
            command: this._config.command,
            args: this._config.args,
            env: {
                ...getDefaultEnvironment(),
                ...this._config.env
            },
            cwd: this._config.cwd
        });

        const client = new Client({
            name: `code-mode:${this._config.id}`,
            version: '0.1.0'
        });

        await client.connect(transport);
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            this._toolsCache = undefined;
        });

        this._client = client;
        return client;
    }
}
