import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { metrics, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

class CollectingMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
}

// Deliberately incomplete setups: no context manager, and a meter provider registered after the first MCP traffic.
const exporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
trace.setGlobalTracerProvider(tracerProvider);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

afterAll(async () => {
    await tracerProvider.shutdown();
    trace.disable();
    propagation.disable();
    metrics.disable();
});

async function callTool(onMeta: (meta: unknown) => void) {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    server.registerTool('get-weather', { inputSchema: z.object({}) }, (_args, ctx) => {
        onMeta(ctx.mcpReq._meta);
        return { content: [] };
    });
    const client = new Client({ name: 'agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: 'get-weather', arguments: {} });
    await client.close();
}

describe('OpenTelemetry setups the SDK has to tolerate', () => {
    it('injects trace context without a registered context manager', async () => {
        let meta: unknown;
        await callTool(m => (meta = m));

        const clientSpan = exporter.getFinishedSpans().find(span => span.name === 'tools/call get-weather' && span.kind === 2)!;
        const { traceId, spanId } = clientSpan.spanContext();
        expect(meta).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
    });

    it('records duration metrics once a meter provider is registered after the first MCP traffic', async () => {
        await callTool(() => {});
        const reader = new CollectingMetricReader();
        metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

        await callTool(() => {});

        const { resourceMetrics } = await reader.collect();
        const names = resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics.map(metric => metric.descriptor.name));
        expect(names).toEqual(expect.arrayContaining(['mcp.client.operation.duration', 'mcp.server.operation.duration']));
    });
});
