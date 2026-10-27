/**
 * OpenTelemetry — a traced server.
 *
 * The application registers an OpenTelemetry SDK and nothing else: the SDK turns
 * every MCP request the server handles into a SERVER span, parented on the
 * client's span through `params._meta`. Code in a tool runs inside that span, so
 * its own spans nest under it.
 *
 * The `trace-info` tool reports the span it ran in, so the client can check the
 * trace crossed the process boundary. A real server would export its spans with
 * an OTLP exporter instead.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import * as z from 'zod/v4';

// Register the OpenTelemetry SDK before any MCP traffic. That is all the MCP server needs.
// Add `spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]` to export the spans.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(new TracerProvider());

function buildServer(): McpServer {
    const server = new McpServer({ name: 'opentelemetry-example', version: '1.0.0' });

    server.registerTool(
        'trace-info',
        {
            description: 'Reports the span this tool call ran in',
            inputSchema: z.object({}),
            outputSchema: z.object({ traceId: z.string(), spanName: z.string(), parentSpanId: z.string() })
        },
        async () => {
            // Your own spans nest under the MCP server span.
            await trace.getTracer('opentelemetry-example').startActiveSpan('look up forecast', async span => span.end());

            const active = trace.getActiveSpan() as (ReturnType<typeof trace.getActiveSpan> & Partial<ReadableSpan>) | undefined;
            const structuredContent = {
                traceId: active?.spanContext().traceId ?? '',
                spanName: active?.name ?? '',
                parentSpanId: active?.parentSpanContext?.spanId ?? ''
            };
            return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
        }
    );

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    // `createMcpHonoApp()` binds the endpoint behind localhost host/origin
    // validation by default, matching the framework factories' defaults.
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
