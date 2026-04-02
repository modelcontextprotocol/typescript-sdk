#!/usr/bin/env node
/**
 * Minimal MCP server using Valibot for schema validation.
 * Use toStandardJsonSchema() from @valibot/to-json-schema to create
 * StandardJSONSchemaV1-compliant schemas.
 */

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

const server = new McpServer({
    name: 'valibot-example',
    version: '1.0.0'
});

// Register a tool with Valibot schema
server.registerTool(
    'greet',
    {
        description: 'Generate a greeting',
        inputSchema: toStandardJsonSchema(v.object({ name: v.string() }))
    },
    async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }]
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
