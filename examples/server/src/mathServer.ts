/**
 * Math MCP server — part of the multi-server chatbot example.
 *
 * Provides three math tools over Streamable HTTP on port 3002:
 *   - add                — add two numbers
 *   - multiply           — multiply two numbers
 *   - convert_temperature — convert between Celsius, Fahrenheit, and Kelvin
 *
 * Start this server alongside weatherServer.ts, then run multiServerChatbot.ts.
 *
 * Usage:
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/mathServer.ts
 */

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const TemperatureUnit = z.enum(['C', 'F', 'K']);

const getServer = (): McpServer => {
    const server = new McpServer({ name: 'math-server', version: '1.0.0' });

    server.registerTool(
        'add',
        {
            description: 'Add two numbers',
            inputSchema: z.object({
                a: z.number().describe('First number'),
                b: z.number().describe('Second number')
            })
        },
        async ({ a, b }): Promise<CallToolResult> => ({
            content: [{ type: 'text', text: `${a} + ${b} = ${a + b}` }]
        })
    );

    server.registerTool(
        'multiply',
        {
            description: 'Multiply two numbers',
            inputSchema: z.object({
                a: z.number().describe('First number'),
                b: z.number().describe('Second number')
            })
        },
        async ({ a, b }): Promise<CallToolResult> => ({
            content: [{ type: 'text', text: `${a} × ${b} = ${a * b}` }]
        })
    );

    server.registerTool(
        'convert_temperature',
        {
            description: 'Convert a temperature between Celsius (C), Fahrenheit (F), and Kelvin (K)',
            inputSchema: z.object({
                value: z.number().describe('Temperature value to convert'),
                from: TemperatureUnit.describe('Source unit: C, F, or K'),
                to: TemperatureUnit.describe('Target unit: C, F, or K')
            })
        },
        async ({ value, from, to }): Promise<CallToolResult> => {
            let celsius: number;

            switch (from) {
                case 'C': {
                    celsius = value;
                    break;
                }
                case 'F': {
                    celsius = (value - 32) * (5 / 9);
                    break;
                }
                case 'K': {
                    celsius = value - 273.15;
                    break;
                }
            }

            let result: number;
            switch (to) {
                case 'C': {
                    result = celsius;
                    break;
                }
                case 'F': {
                    result = celsius * (9 / 5) + 32;
                    break;
                }
                case 'K': {
                    result = celsius + 273.15;
                    break;
                }
            }

            return {
                content: [{ type: 'text', text: `${value}°${from} = ${result.toFixed(2)}°${to}` }]
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

const PORT = 3002;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start math server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`[math-server] listening on :${PORT} — tools: add, multiply, convert_temperature`);
});

process.on('SIGINT', () => {
    console.log('[math-server] shutting down');
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
});
