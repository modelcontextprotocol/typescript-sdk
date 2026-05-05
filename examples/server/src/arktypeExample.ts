#!/usr/bin/env node
/**
 * Minimal MCP server using ArkType for schema validation.
 * ArkType implements the Standard Schema spec with built-in JSON Schema conversion.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { type } from 'arktype';

const server = new McpServer({
    name: 'arktype-example',
    version: '1.0.0'
});

// Register a tool with ArkType schema
server.registerTool(
    'greet',
    {
        description: 'Generate a greeting',
        inputSchema: type({ name: 'string' })
    },
    async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }]
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
