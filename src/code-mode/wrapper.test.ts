import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult, Tool } from '../types.js';
import type { DownstreamConfig, DownstreamHandle } from './downstream.js';
import { CodeModeWrapper } from './wrapper.js';

class FakeHandle implements DownstreamHandle {
    public listTools: () => Promise<Tool[]>;
    public getTool: (name: string) => Promise<Tool | undefined>;
    public callTool: (toolName: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
    public close: () => Promise<void>;

    constructor(
        public readonly config: DownstreamConfig,
        tools: Tool[],
        callResult: CallToolResult
    ) {
        this.listTools = vi.fn(async () => tools);
        this.getTool = vi.fn(async (name: string) => tools.find(tool => tool.name === name));
        this.callTool = vi.fn(async () => callResult);
        this.close = vi.fn(async () => undefined);
    }
}

const SAMPLE_TOOL: Tool = {
    name: 'demo-tool',
    description: 'Demo tool',
    inputSchema: {
        type: 'object',
        properties: {
            message: {
                type: 'string'
            }
        }
    },
    annotations: undefined
};

const SAMPLE_RESULT: CallToolResult = {
    content: [
        {
            type: 'text',
            text: 'ok'
        }
    ],
    isError: false
};

describe('CodeModeWrapper', () => {
    const downstreamConfig: DownstreamConfig = {
        id: 'alpha',
        description: 'Demo downstream',
        command: 'node',
        args: ['noop.js']
    };

    it('lists tool summaries from downstream servers', async () => {
        const handle = new FakeHandle(downstreamConfig, [SAMPLE_TOOL], SAMPLE_RESULT);
        const wrapper = new CodeModeWrapper({
            downstreams: [downstreamConfig],
            downstreamFactory: () => handle
        });

        const summaries = await wrapper.listToolSummaries('alpha');
        expect(summaries).toEqual([
            expect.objectContaining({
                serverId: 'alpha',
                toolName: 'demo-tool',
                description: 'Demo tool'
            })
        ]);
    });

    it('returns implementation summaries with generated signatures', async () => {
        const handle = new FakeHandle(downstreamConfig, [SAMPLE_TOOL], SAMPLE_RESULT);
        const wrapper = new CodeModeWrapper({
            downstreams: [downstreamConfig],
            downstreamFactory: () => handle
        });

        const implementation = await wrapper.getToolImplementationSummary('alpha', 'demo-tool');
        expect(implementation.signature).toContain('export async function demo_tool');
    });

    it('proxies tool calls to the downstream handle', async () => {
        const handle = new FakeHandle(downstreamConfig, [SAMPLE_TOOL], SAMPLE_RESULT);
        const wrapper = new CodeModeWrapper({
            downstreams: [downstreamConfig],
            downstreamFactory: () => handle
        });

        const result = await wrapper.callDownstreamTool('alpha', 'demo-tool', { message: 'hello' });
        expect(result).toEqual(SAMPLE_RESULT);
        expect(handle.callTool).toHaveBeenCalledWith('demo-tool', { message: 'hello' });
    });

    it('lists configured MCP servers', async () => {
        const handle = new FakeHandle(downstreamConfig, [SAMPLE_TOOL], SAMPLE_RESULT);
        const wrapper = new CodeModeWrapper({
            downstreams: [downstreamConfig],
            downstreamFactory: () => handle
        });

        const servers = await wrapper.listMcpServers();
        expect(servers).toEqual([
            expect.objectContaining({
                serverId: 'alpha',
                description: 'Demo downstream'
            })
        ]);
    });
});
