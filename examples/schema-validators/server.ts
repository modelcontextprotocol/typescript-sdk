/**
 * Tool input/output schemas via three Standard-Schema-compatible libraries
 * (Zod, ArkType, Valibot) plus an `outputSchema` that emits
 * `structuredContent`. The SDK accepts any Standard-Schema-with-JSON value;
 * Valibot needs the `@valibot/to-json-schema` wrapper to expose JSON Schema
 * conversion. One binary, either transport.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'schema-validators-example', version: '1.0.0' });

    server.registerTool(
        'greet-zod',
        { description: 'Greet (Zod inputSchema)', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}! (zod)` }] })
    );

    server.registerTool(
        'greet-arktype',
        { description: 'Greet (ArkType inputSchema)', inputSchema: type({ name: 'string' }) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}! (arktype)` }] })
    );

    server.registerTool(
        'greet-valibot',
        { description: 'Greet (Valibot inputSchema)', inputSchema: toStandardJsonSchema(v.object({ name: v.string() })) },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}! (valibot)` }] })
    );

    // outputSchema → structuredContent.
    server.registerTool(
        'get-weather',
        {
            description: 'Get (canned) weather information',
            inputSchema: z.object({ city: z.string() }),
            outputSchema: z.object({ city: z.string(), conditions: z.enum(['sunny', 'cloudy', 'rainy']), celsius: z.number() })
        },
        async ({ city }) => {
            const structuredContent = { city, conditions: 'sunny' as const, celsius: 21 };
            return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
        }
    );

    return server;
}

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
