// Run with: npx tsx src/examples/server/toolWithSampleServer.ts

import { McpServer } from '../../server/mcp.js';
import { StdioServerTransport } from '../../server/stdio.js';
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
        inputSchema: {
            text: z.string().describe('Text to summarize')
        }
    },
    async ({ text }) => {
        // Call the LLM through MCP sampling
        const response = await mcpServer.server.createMessage({
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

        // Extract text from response content (could be single block or array)
        const contentBlock = Array.isArray(response.content) ? response.content[0] : response.content;
        return {
            content: [
                {
                    type: 'text',
                    text: contentBlock?.type === 'text' ? contentBlock.text : 'Unable to generate summary'
                }
            ]
        };
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.log('MCP server is running...');
}

main().catch(error => {
    console.error('Server error:', error);
    process.exit(1);
});
