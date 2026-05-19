// Run with: pnpm tsx src/toolWithSampleServer.ts

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const mcpServer = new McpServer({
    name: 'tools-with-sample-server',
    version: '1.0.0'
});

// Tool that uses LLM sampling to summarize any text
mcpServer.registerTool(
    'summarize',
    {
        description: 'Summarize any text using an LLM',
        inputSchema: z.object({
            text: z.string().describe('Text to summarize')
        })
    },
    async ({ text }, ctx) => {
        // Call the LLM through MCP sampling.
        // ctx.mcpReq.requestSampling works under both the pre-2026 connection model
        // (sends sampling/createMessage to the connected client) and the 2026
        // stateless model (returns an input_required result; the client retries
        // with the response embedded). See SEP-2322.
        const response = await ctx.mcpReq.requestSampling({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Please summarize the following text concisely:\n\n${text}`
                    }
                }
            ],
            maxTokens: 500
        });

        const content = response.content;
        const summary = content.type === 'text' ? content.text : 'Unable to generate summary';
        return {
            content: [{ type: 'text', text: summary }]
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.log('MCP server is running...');
}

try {
    await main();
} catch (error) {
    console.error('Server error:', error);
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}
