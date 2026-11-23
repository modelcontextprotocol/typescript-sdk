/**
 * Drives the OpenTelemetry example: one tool call inside an agent span, then
 * checks the trace on both sides of the wire.
 *
 * - The client's `tools/call trace-info` span is a child of the agent span.
 * - The server's span for that call is in the same trace, and its parent is
 *   the client's span: trace context crossed the wire in `params._meta`.
 * - A span the tool started nests under the server span.
 * - The client recorded `mcp.client.operation.duration` for the call.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { context, metrics, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

// The client application's OpenTelemetry SDK. In-memory here so the example can assert on what it recorded.
const exporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(tracerProvider);
class CollectingMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
}
const metricReader = new CollectingMetricReader();
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [metricReader] }));

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'opentelemetry-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

const result = await trace.getTracer('agent').startActiveSpan('invoke_agent', async agentSpan => {
    try {
        return await client.callTool({ name: 'trace-info', arguments: {} });
    } finally {
        agentSpan.end();
    }
});
const server = result.structuredContent as { traceId: string; spanName: string; parentSpanId: string };

const spans = exporter.getFinishedSpans();
const agentSpan = spans.find(span => span.name === 'invoke_agent')!;
const callSpan = spans.find(span => span.name === 'tools/call trace-info' && span.kind === SpanKind.CLIENT);
check.ok(callSpan, 'the client should record a "tools/call trace-info" CLIENT span');
check.equal(callSpan.parentSpanContext?.spanId, agentSpan.spanContext().spanId, 'the call span should be a child of the agent span');
check.equal(callSpan.attributes['gen_ai.tool.name'], 'trace-info');
check.equal(callSpan.attributes['mcp.protocol.version'], era === 'modern' ? '2026-07-28' : '2025-11-25');

check.equal(server.traceId, callSpan.spanContext().traceId, 'the server span should be in the client trace');
check.equal(server.parentSpanId, callSpan.spanContext().spanId, 'the server span should be a child of the client call span');
check.equal(server.spanName, 'tools/call trace-info');

const { resourceMetrics } = await metricReader.collect();
const duration = resourceMetrics.scopeMetrics
    .flatMap(scope => scope.metrics)
    .find(m => m.descriptor.name === 'mcp.client.operation.duration');
check.ok(duration, 'the client should record mcp.client.operation.duration');
check.ok(duration.dataPoints.some(point => point.attributes['gen_ai.tool.name'] === 'trace-info'));

console.log(`trace ${server.traceId}`);
console.log(`  ${agentSpan.name} (client process)`);
console.log(`    ${callSpan.name} (client process)`);
console.log(`      ${server.spanName} (server process)`);

await client.close();
await tracerProvider.shutdown();
