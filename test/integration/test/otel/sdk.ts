import type { Tracer } from '@opentelemetry/api';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { DataPoint, Histogram, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

class CollectingMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
}

/**
 * Registers an OpenTelemetry SDK globally, exactly as an application would, but keeping spans
 * and metrics in memory. Call it once per test file; `unregister` puts the no-op API back.
 */
export function registerTestSdk() {
    const exporter = new InMemorySpanExporter();
    const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    const reader = new CollectingMetricReader();
    const meterProvider = new MeterProvider({ readers: [reader] });
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(
        new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] })
    );
    trace.setGlobalTracerProvider(tracerProvider);
    metrics.setGlobalMeterProvider(meterProvider);
    const tracer: Tracer = trace.getTracer('test');

    const spans = (): ReadableSpan[] => exporter.getFinishedSpans();
    /** The one finished span with this name and kind; fails when there is not exactly one. */
    const span = (name: string, kind: number): ReadableSpan => {
        const matches = spans().filter(s => s.name === name && s.kind === kind);
        if (matches.length !== 1) {
            throw new Error(
                `expected one ${name} span of kind ${kind}, found ${matches.length} in [${spans()
                    .map(s => `${s.name}/${s.kind}`)
                    .join(', ')}]`
            );
        }
        return matches[0]!;
    };
    /** Data points recorded so far for a histogram, across every instrumentation scope (client and server both record). */
    const histogram = async (name: string): Promise<{ unit: string; boundaries: number[]; points: DataPoint<Histogram>[] }> => {
        const { resourceMetrics } = await reader.collect();
        const found = findMetrics(resourceMetrics, name);
        if (found.length === 0) throw new Error(`no ${name} metric was recorded`);
        const points = found.flatMap(metric => metric.dataPoints as DataPoint<Histogram>[]);
        return { unit: found[0]!.descriptor.unit, boundaries: points[0]?.value.buckets.boundaries ?? [], points };
    };
    const unregister = async () => {
        await tracerProvider.shutdown();
        await meterProvider.shutdown();
        trace.disable();
        metrics.disable();
        propagation.disable();
        context.disable();
    };

    return { tracer, spans, span, histogram, reset: () => exporter.reset(), unregister };
}

function findMetrics(resourceMetrics: ResourceMetrics, name: string) {
    return resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics.filter(m => m.descriptor.name === name));
}
