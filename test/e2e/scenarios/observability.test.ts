/**
 * OpenTelemetry tests. They register a global OpenTelemetry SDK, so they live in
 * their own file: every other scenario runs with the no-op API and an untouched wire.
 */

import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeEach, expect } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const exporter = new InMemorySpanExporter();
const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(tracerProvider);

beforeEach(() => exporter.reset());
afterAll(async () => {
    await tracerProvider.shutdown();
    trace.disable();
    propagation.disable();
    context.disable();
});

verifies('protocol:meta:trace-context-otel', async ({ transport }: TestArgs) => {
    const handlerSaw: { traceparent?: unknown; activeSpanId?: string }[] = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('traced', { inputSchema: z.object({}) }, (_args, ctx) => {
            handlerSaw.push({ traceparent: ctx.mcpReq._meta?.traceparent, activeSpanId: trace.getActiveSpan()?.spanContext().spanId });
            return { content: [{ type: 'text', text: 'ok' }] };
        });
        return s;
    };
    const client = new Client({ name: 'c', version: '0' });
    await using _ = await wire(transport, makeServer, client);
    exporter.reset();

    await client.callTool({ name: 'traced', arguments: {} });

    const spans = exporter.getFinishedSpans();
    const clientSpan = spans.find(s => s.name === 'tools/call traced' && s.kind === SpanKind.CLIENT);
    const serverSpan = spans.find(s => s.name === 'tools/call traced' && s.kind === SpanKind.SERVER);
    expect(clientSpan).toBeDefined();
    expect(serverSpan).toBeDefined();
    const { traceId, spanId } = clientSpan!.spanContext();
    expect(serverSpan!.spanContext().traceId).toBe(traceId);
    expect(serverSpan!.parentSpanContext?.spanId).toBe(spanId);
    expect(handlerSaw).toEqual([{ traceparent: `00-${traceId}-${spanId}-01`, activeSpanId: serverSpan!.spanContext().spanId }]);
});
