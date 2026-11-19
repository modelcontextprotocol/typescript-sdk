/**
 * Companion example for `docs/advanced/opentelemetry.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and server and prints the spans and
 * metrics the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/opentelemetry.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { DataPoint, Histogram } from '@opentelemetry/sdk-metrics';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';

class CollectingMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
}
const metricReader = new CollectingMetricReader();

// "Register an OpenTelemetry SDK" — the application's job, once, before any MCP traffic.
//#region sdk_setup
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

// Swap the in-memory exporter for an OTLP exporter to send spans to a backend.
const exporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(tracerProvider);
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));
//#endregion sdk_setup

// "Register an OpenTelemetry SDK" — the server needs no telemetry configuration.
//#region server_traced
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'weather', version: '1.0.0' });

server.registerTool('get-weather', { inputSchema: z.object({ city: z.string() }) }, async ({ city }) => {
    // Spans started here are children of the "tools/call get-weather" server span.
    const forecast = await trace.getTracer('weather').startActiveSpan('fetch forecast', async span => {
        span.end();
        return 'sunny';
    });
    return { content: [{ type: 'text', text: `${city}: ${forecast}` }] };
});
//#endregion server_traced

// ---------------------------------------------------------------------------
// Harness (not shown on the page). Connects a client in memory, makes one tool
// call inside an agent span, and prints what was recorded.
// ---------------------------------------------------------------------------

const { SpanKind } = await import('@opentelemetry/api');
const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
const client = new Client({ name: 'agent', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
exporter.reset();

// "See the spans" — the call the page's span tree comes from.
//#region callTool_traced
await trace.getTracer('agent').startActiveSpan('invoke_agent', async agentSpan => {
    await client.callTool({ name: 'get-weather', arguments: { city: 'Lisbon' } });
    agentSpan.end();
});
//#endregion callTool_traced

const spans = exporter.getFinishedSpans();
const kinds: Record<number, string> = { [SpanKind.INTERNAL]: 'internal', [SpanKind.SERVER]: 'server', [SpanKind.CLIENT]: 'client' };
const printTree = (parent: ReadableSpan | undefined, depth: number) => {
    const children = spans
        .filter(span => span.parentSpanContext?.spanId === parent?.spanContext().spanId)
        .toSorted((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    for (const child of children) {
        console.log(`${'  '.repeat(depth)}${child.name} (${kinds[child.kind]})`);
        printTree(child, depth + 1);
    }
};
printTree(undefined, 0);

const toolServerSpan = spans.find(span => span.name === 'tools/call get-weather' && span.kind === SpanKind.SERVER);
if (toolServerSpan === undefined) throw new Error('opentelemetry.md claim failed: no tools/call server span');
const { 'jsonrpc.request.id': _requestId, ...stableAttributes } = toolServerSpan.attributes;
console.log(toolServerSpan.instrumentationScope.name, stableAttributes);

const { resourceMetrics } = await metricReader.collect();
const clientDuration = resourceMetrics.scopeMetrics
    .filter(scope => scope.scope.name === '@modelcontextprotocol/client')
    .flatMap(scope => scope.metrics)
    .find(metric => metric.descriptor.name === 'mcp.client.operation.duration');
const toolCallPoint = (clientDuration?.dataPoints as DataPoint<Histogram>[] | undefined)?.find(
    point => point.attributes['mcp.method.name'] === 'tools/call'
);
if (toolCallPoint === undefined) throw new Error('opentelemetry.md claim failed: no tools/call duration was recorded');
console.log(`${clientDuration!.descriptor.name} (${clientDuration!.descriptor.unit})`, toolCallPoint.attributes);

await client.close();
await tracerProvider.shutdown();
