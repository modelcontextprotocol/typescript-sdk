/**
 * Weather MCP server — part of the multi-server chatbot example.
 *
 * Provides two weather tools over Streamable HTTP on port 3001:
 *   - get_weather  — current conditions for a city
 *   - get_forecast — N-day forecast for a city
 *
 * Start this server alongside mathServer.ts, then run multiServerChatbot.ts.
 *
 * Usage:
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/weatherServer.ts
 */

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const getServer = (): McpServer => {
    const server = new McpServer({ name: 'weather-server', version: '1.0.0' });

    server.registerTool(
        'get_weather',
        {
            description: 'Get current weather conditions for a city',
            inputSchema: z.object({
                city: z.string().describe('City name')
            })
        },
        async ({ city }): Promise<CallToolResult> => ({
            content: [{ type: 'text', text: `Current weather in ${city}: sunny, 22°C, humidity 45%.` }]
        })
    );

    server.registerTool(
        'get_forecast',
        {
            description: 'Get a multi-day weather forecast for a city',
            inputSchema: z.object({
                city: z.string().describe('City name'),
                days: z.number().int().min(1).max(7).default(3).describe('Number of days (1–7)')
            })
        },
        async ({ city, days }): Promise<CallToolResult> => {
            const forecasts = Array.from({ length: days }, (_, i) => `Day ${i + 1}: sunny, ~${20 + i}°C`);
            return {
                content: [{ type: 'text', text: `${days}-day forecast for ${city}:\n${forecasts.join('\n')}` }]
            };
        }
    );

    return server;
};

const app = createMcpExpressApp();

app.post('/mcp', async (req: Request, res: Response) => {
    const server = getServer();
    try {
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
            transport.close();
            server.close();
        });
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

app.get('/mcp', async (req: Request, res: Response) => {
    console.log('Received GET MCP request');
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_000, message: 'Method not allowed.' }, id: null }));
});

app.delete('/mcp', async (req: Request, res: Response) => {
    console.log('Received DELETE MCP request');
    res.writeHead(405).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32_000, message: 'Method not allowed.' }, id: null }));
});

const PORT = 3001;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start weather server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`[weather-server] listening on :${PORT} — tools: get_weather, get_forecast`);
});

process.on('SIGINT', () => {
    console.log('[weather-server] shutting down');
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
});
