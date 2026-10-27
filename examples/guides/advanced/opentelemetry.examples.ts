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
import { metrics, SpanKind } from '@opentelemetry/api';
import type { DataPoint, Histogram } from '@opentelemetry/sdk-metrics';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

class CollectingMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
}
const metricReader = new CollectingMetricReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));

// "Start the OpenTelemetry SDK" — the application's job, once, before any MCP traffic.
//#region sdk_setup
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';

// Swap the in-memory exporter for an OTLP exporter to send spans to a backend.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
// Registers the tracer provider, the W3C propagators and an AsyncLocalStorage context manager.
provider.register();
//#endregion sdk_setup

// "Trace a server" — the page's lead block.
//#region openTelemetry_server
import { openTelemetry } from '@modelcontextprotocol/otel';
import { McpServer } from '@modelcontextprotocol/server';
import { trace } from '@opentelemetry/api';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation: openTelemetry() });

server.registerTool('get-weather', { inputSchema: z.object({ city: z.string() }) }, async ({ city }) => {
    // Spans started here are children of the "tools/call get-weather" server span.
    const forecast = await trace.getTracer('weather').startActiveSpan('fetch forecast', async span => {
        span.end();
        return 'sunny';
    });
    return { content: [{ type: 'text', text: `${city}: ${forecast}` }] };
});
//#endregion openTelemetry_server

// "Trace a client"
//#region openTelemetry_client
import { Client } from '@modelcontextprotocol/client';

const client = new Client({ name: 'agent', version: '1.0.0' }, { instrumentation: openTelemetry() });
//#endregion openTelemetry_client

// "Serve over HTTP" — one instrumentation shared by every per-request server.
//#region openTelemetry_createMcpHandler
import { createMcpHandler } from '@modelcontextprotocol/server';

const instrumentation = openTelemetry();

const handler = createMcpHandler(() => {
    const perRequest = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation });
    // perRequest.registerTool(...)
    return perRequest;
});
//#endregion openTelemetry_createMcpHandler
void handler;

// "Record tool arguments and results"
//#region openTelemetry_captureContent
const debugInstrumentation = openTelemetry({ captureContent: true });
//#endregion openTelemetry_captureContent
void debugInstrumentation;

// ---------------------------------------------------------------------------
// Harness (not shown on the page). Connects the client and server in memory,
// makes one tool call inside an agent span, and prints what was recorded.
// ---------------------------------------------------------------------------

const { InMemoryTransport } = await import('@modelcontextprotocol/client');
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
exporter.reset();

// "Trace a client" — the call the page's span tree comes from.
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
console.log(stableAttributes);

const { resourceMetrics } = await metricReader.collect();
const clientDuration = resourceMetrics.scopeMetrics
    .flatMap(scope => scope.metrics)
    .find(metric => metric.descriptor.name === 'mcp.client.operation.duration');
const toolCallPoint = (clientDuration?.dataPoints as DataPoint<Histogram>[] | undefined)?.find(
    point => point.attributes['mcp.method.name'] === 'tools/call'
);
if (toolCallPoint === undefined) throw new Error('opentelemetry.md claim failed: no tools/call duration was recorded');
console.log(`${clientDuration!.descriptor.name} (${clientDuration!.descriptor.unit})`, toolCallPoint.attributes);

await client.close();
await provider.shutdown();
