import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
});

describe('OpenTelemetry with no SDK registered', () => {
    it('records nothing, injects nothing, and passes caller-supplied trace context through untouched', async () => {
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: 'weather', version: '1.0.0' });
            server.registerTool('echo-meta', { inputSchema: z.object({}) }, (_args, ctx) => ({
                content: [{ type: 'text', text: JSON.stringify(ctx.mcpReq._meta ?? {}) }]
            }));
            return server;
        });
        const httpServer: HttpServer = createServer(toNodeHandler(handler));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await handler.close();
            httpServer.close();
        });
        const client = new Client({ name: 'agent', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());
        const upstream = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

        const plain = await client.callTool({ name: 'echo-meta', arguments: {} });
        const passthrough = await client.callTool({ name: 'echo-meta', arguments: {}, _meta: { traceparent: upstream } });

        expect(plain.content).toEqual([{ type: 'text', text: '{}' }]);
        expect(passthrough.content).toEqual([{ type: 'text', text: JSON.stringify({ traceparent: upstream }) }]);
        expect(trace.getActiveSpan()).toBeUndefined();
    });
});
