import type { Attributes, Tracer } from '@opentelemetry/api';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { DataPoint, Histogram, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import type { OpenTelemetryOptions, ProtocolInstrumentation } from '../src/index';
import { openTelemetry } from '../src/index';

// The context manager is process-global; everything else in a test is local to it.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

class TestMetricReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
}

/** An OpenTelemetry SDK that keeps spans and metrics in memory, wired into `openTelemetry()` without touching globals. */
export function telemetry(options: Pick<OpenTelemetryOptions, 'captureContent'> = {}) {
    const exporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const reader = new TestMetricReader();
    const meterProvider = new MeterProvider({ readers: [reader] });
    const propagator = new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] });
    const instrumentation: ProtocolInstrumentation = openTelemetry({ tracerProvider, meterProvider, propagator, ...options });
    const tracer: Tracer = tracerProvider.getTracer('test');

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
    /** Data points recorded for a histogram. */
    const histogram = async (name: string): Promise<{ unit: string; boundaries: number[]; points: DataPoint<Histogram>[] }> => {
        const { resourceMetrics } = await reader.collect();
        const metric = findMetric(resourceMetrics, name);
        if (metric === undefined) throw new Error(`no ${name} metric was recorded`);
        const points = metric.dataPoints as DataPoint<Histogram>[];
        return { unit: metric.descriptor.unit, boundaries: points[0]?.value.buckets.boundaries ?? [], points };
    };

    return { instrumentation, tracer, spans, span, histogram, propagator };
}

function findMetric(resourceMetrics: ResourceMetrics, name: string) {
    for (const scope of resourceMetrics.scopeMetrics) {
        const metric = scope.metrics.find(m => m.descriptor.name === name);
        if (metric !== undefined) return metric;
    }
    return;
}

/** Just the attributes of a span, for readable assertions. */
export function attributesOf(span: ReadableSpan): Attributes {
    return { ...span.attributes };
}
