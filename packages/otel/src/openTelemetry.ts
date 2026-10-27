import type {
    Attributes,
    Context,
    Histogram,
    Link,
    MeterProvider,
    Span,
    TextMapGetter,
    TextMapPropagator,
    TracerProvider
} from '@opentelemetry/api';
import {
    context,
    defaultTextMapSetter,
    isSpanContextValid,
    metrics,
    propagation,
    SpanKind,
    SpanStatusCode,
    trace
} from '@opentelemetry/api';

import type { InboundOperation, OperationBase, OperationOutcome, OutboundOperation, ProtocolInstrumentation } from './types';

/**
 * Options for {@linkcode openTelemetry}.
 */
export interface OpenTelemetryOptions {
    /**
     * Where spans go.
     *
     * @default the global tracer provider
     */
    tracerProvider?: TracerProvider;
    /**
     * Where metrics go.
     *
     * @default the global meter provider
     */
    meterProvider?: MeterProvider;
    /**
     * How trace context is written to and read from `params._meta`.
     *
     * @default the global propagator
     */
    propagator?: TextMapPropagator;
    /**
     * Record tool arguments, tool results and prompt arguments on spans
     * (`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`,
     * `gen_ai.prompt.variable.<name>`). These can hold sensitive data.
     *
     * @default false
     */
    captureContent?: boolean;
}

const SCOPE_NAME = '@modelcontextprotocol/otel';

/** Bucket boundaries the MCP semantic conventions specify for every MCP duration histogram. */
const DURATION_BUCKETS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

/** Codes the conventions say a receiver should not treat as errors: the caller sent something it could not serve. */
const NOT_RECEIVER_ERRORS = new Set([-32_700, -32_600, -32_601, -32_602, -32_002]);
const INVALID_PARAMS = -32_602;

const RESOURCE_URI_METHODS = new Set(['resources/read', 'resources/subscribe', 'resources/unsubscribe', 'notifications/resources/updated']);

/** Log notifications are deprecated (SEP-2577) and belong in logs, not spans. */
const SKIPPED_METHODS = new Set(['notifications/message']);

const STANDARD_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);

/** Attributes that may go on metrics; everything else is span-only. */
const METRIC_ATTRIBUTES = [
    'mcp.method.name',
    'mcp.protocol.version',
    'gen_ai.operation.name',
    'gen_ai.tool.name',
    'gen_ai.prompt.name',
    'network.transport',
    'network.protocol.name'
] as const;

const metaGetter: TextMapGetter<Readonly<Record<string, unknown>>> = {
    keys: carrier => Object.keys(carrier),
    get: (carrier, key) => {
        const value = carrier[key];
        return typeof value === 'string' ? value : undefined;
    }
};

type Side = 'client' | 'server';

/**
 * Traces and measures every MCP request and notification an instance sends or
 * receives, following the OpenTelemetry semantic conventions for MCP, and
 * propagates trace context through `params._meta`.
 *
 * Create it once and pass it as the `instrumentation` option of `Client`,
 * `McpServer` or `Server`. One instance can be shared by every server a
 * `createMcpHandler` factory builds.
 *
 * @example
 * ```ts
 * const instrumentation = openTelemetry();
 * const server = new McpServer({ name: 'weather', version: '1.0.0' }, { instrumentation });
 * ```
 */
export function openTelemetry(options: OpenTelemetryOptions = {}): ProtocolInstrumentation {
    const { propagator, captureContent = false } = options;
    const tracerProvider = options.tracerProvider ?? trace.getTracerProvider();
    const tracer = tracerProvider.getTracer(SCOPE_NAME);

    // Created on first use: the global meter provider has no proxy, so instruments made before the SDK starts would stay no-ops.
    let durations: Record<Side, Histogram> | undefined;
    const duration = (side: Side): Histogram => {
        if (durations === undefined) {
            const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE_NAME);
            const histogram = (name: string, description: string) =>
                meter.createHistogram(name, { unit: 's', description, advice: { explicitBucketBoundaries: DURATION_BUCKETS } });
            durations = {
                client: histogram(
                    'mcp.client.operation.duration',
                    'The duration of the MCP request or notification as observed on the sender from the time it was sent until the response or ack is received.'
                ),
                server: histogram(
                    'mcp.server.operation.duration',
                    'MCP request or notification duration as observed on the receiver from the time it was received until the result or ack is sent.'
                )
            };
        }
        return durations[side];
    };

    const inject = (ctx: Context, carrier: Record<string, string>) =>
        propagator === undefined
            ? propagation.inject(ctx, carrier, defaultTextMapSetter)
            : propagator.inject(ctx, carrier, defaultTextMapSetter);
    const extract = (ctx: Context, carrier: Readonly<Record<string, unknown>>) =>
        propagator === undefined ? propagation.extract(ctx, carrier, metaGetter) : propagator.extract(ctx, carrier, metaGetter);

    const finish = (
        span: Span,
        side: Side,
        method: string,
        target: string | undefined,
        metricAttributes: Attributes,
        outcome: OperationOutcome,
        started: number
    ) => {
        let errorType: string | undefined;
        switch (outcome.type) {
            case 'result': {
                if (method === 'tools/call' && outcome.result.isError === true) {
                    errorType = 'tool_error';
                    span.setStatus({ code: SpanStatusCode.ERROR });
                } else if (captureContent && method === 'tools/call' && span.isRecording()) {
                    const value = toJson(outcome.result.structuredContent ?? outcome.result.content);
                    if (value !== undefined) span.setAttribute('gen_ai.tool.call.result', value);
                }
                break;
            }
            case 'error': {
                const { code, message } = outcome.error;
                span.setAttribute('rpc.response.status_code', String(code));
                metricAttributes['rpc.response.status_code'] = String(code);
                if (side === 'client' || !NOT_RECEIVER_ERRORS.has(code)) {
                    errorType = String(code);
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                    if (side === 'server' && isUnexpectedException(outcome.cause)) span.recordException(outcome.cause);
                }
                // An unknown or disabled tool or prompt: keep the client-chosen name out of the span name and metrics.
                if (side === 'server' && code === INVALID_PARAMS && target !== undefined) {
                    span.updateName(method);
                    delete metricAttributes['gen_ai.tool.name'];
                    delete metricAttributes['gen_ai.prompt.name'];
                }
                break;
            }
            case 'timeout': {
                errorType = 'timeout';
                span.setStatus({ code: SpanStatusCode.ERROR });
                break;
            }
            case 'cancelled': {
                errorType = 'cancelled';
                span.setStatus({ code: SpanStatusCode.ERROR });
                break;
            }
            case 'closed': {
                errorType = 'connection_closed';
                span.setStatus({ code: SpanStatusCode.ERROR });
                break;
            }
            case 'failed': {
                errorType = errorTypeOf(outcome.error);
                span.setStatus({ code: SpanStatusCode.ERROR, ...(outcome.error instanceof Error && { message: outcome.error.message }) });
                break;
            }
            case 'delivered': {
                break;
            }
        }
        if (errorType !== undefined) {
            span.setAttribute('error.type', errorType);
            metricAttributes['error.type'] = errorType;
        }
        span.end();
        duration(side).record((performance.now() - started) / 1000, metricAttributes);
    };

    return {
        send(operation: OutboundOperation) {
            if (SKIPPED_METHODS.has(operation.method)) return;
            // Trace context the caller already put in `_meta` parents the span; otherwise the active context does.
            const parent = extract(context.active(), operation.carrier);
            const target = targetOf(operation);
            const attributes = startAttributes(operation, operation.method, target, captureContent);
            const span = tracer.startSpan(spanName(operation.method, target), { kind: SpanKind.CLIENT, attributes }, parent);
            const spanContext = trace.setSpan(parent, span);
            const injected: Record<string, string> = {};
            inject(spanContext, injected);
            Object.assign(operation.carrier, injected);
            const metricAttributes = pickMetricAttributes(attributes);
            const started = performance.now();
            return {
                run: fn => context.with(spanContext, fn),
                end: outcome => finish(span, 'client', operation.method, target, metricAttributes, outcome, started)
            };
        },

        receive(operation: InboundOperation) {
            if (SKIPPED_METHODS.has(operation.method)) return;
            const active = context.active();
            const parent = operation.meta === undefined ? active : extract(active, operation.meta);
            // With a remote parent from `_meta`, the ambient span (an HTTP server span, say) becomes a link.
            const ambient = trace.getSpanContext(active);
            const remote = trace.getSpanContext(parent);
            const links: Link[] =
                remote !== undefined &&
                remote !== ambient &&
                isSpanContextValid(remote) &&
                ambient !== undefined &&
                isSpanContextValid(ambient)
                    ? [{ context: ambient }]
                    : [];
            // A method nobody handles is a client-chosen string: record it as `_OTHER` to bound cardinality.
            const method = operation.handled ? operation.method : '_OTHER';
            const target = operation.handled ? targetOf(operation) : undefined;
            const attributes = startAttributes(operation, method, target, captureContent && operation.handled);
            if (operation.httpRequest !== undefined) {
                attributes['network.protocol.name'] = 'http';
                attributes['network.transport'] = 'tcp';
            }
            const span = tracer.startSpan(spanName(method, target), { kind: SpanKind.SERVER, attributes, links }, parent);
            const spanContext = trace.setSpan(parent, span);
            const metricAttributes = pickMetricAttributes(attributes);
            const started = performance.now();
            return {
                run: fn => context.with(spanContext, fn),
                end: outcome => finish(span, 'server', method, target, metricAttributes, outcome, started)
            };
        }
    };
}

/** The low-cardinality span-name target: the tool or prompt name. */
function targetOf(operation: OperationBase): string | undefined {
    if (operation.method !== 'tools/call' && operation.method !== 'prompts/get') return undefined;
    const name = operation.params?.name;
    return typeof name === 'string' ? name : undefined;
}

function spanName(method: string, target: string | undefined): string {
    return target === undefined ? method : `${method} ${target}`;
}

function startAttributes(operation: OperationBase, method: string, target: string | undefined, captureContent: boolean): Attributes {
    const attributes: Attributes = { 'mcp.method.name': method };
    if (operation.id !== undefined) attributes['jsonrpc.request.id'] = String(operation.id);
    const requestedVersion = operation.method === 'initialize' ? operation.params?.protocolVersion : undefined;
    const protocolVersion = operation.protocolVersion ?? (typeof requestedVersion === 'string' ? requestedVersion : undefined);
    if (protocolVersion !== undefined) attributes['mcp.protocol.version'] = protocolVersion;
    if (operation.sessionId !== undefined) attributes['mcp.session.id'] = operation.sessionId;
    if (method === 'tools/call') {
        attributes['gen_ai.operation.name'] = 'execute_tool';
        if (target !== undefined) attributes['gen_ai.tool.name'] = target;
        if (captureContent) {
            const value = toJson(operation.params?.arguments);
            if (value !== undefined) attributes['gen_ai.tool.call.arguments'] = value;
        }
    }
    if (method === 'prompts/get') {
        if (target !== undefined) attributes['gen_ai.prompt.name'] = target;
        const promptArguments = operation.params?.arguments;
        if (captureContent && isRecord(promptArguments)) {
            for (const [name, value] of Object.entries(promptArguments)) {
                attributes[`gen_ai.prompt.variable.${name}`] = typeof value === 'string' ? value : (toJson(value) ?? '');
            }
        }
    }
    if (RESOURCE_URI_METHODS.has(method)) {
        const uri = operation.params?.uri;
        if (typeof uri === 'string') attributes['mcp.resource.uri'] = uri;
    }
    return attributes;
}

function pickMetricAttributes(attributes: Attributes): Attributes {
    const picked: Attributes = {};
    for (const key of METRIC_ATTRIBUTES) {
        if (attributes[key] !== undefined) picked[key] = attributes[key];
    }
    return picked;
}

/** A thrown value that is not a protocol error (those carry a numeric `code`) and is worth an exception event. */
function isUnexpectedException(cause: unknown): cause is Error {
    return cause instanceof Error && typeof (cause as { code?: unknown }).code !== 'number';
}

/** A low-cardinality `error.type` for a local failure: an SDK or system error code, a standard error name, or `_OTHER`. */
function errorTypeOf(error: unknown): string {
    if (!(error instanceof Error)) return '_OTHER';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
    return STANDARD_ERROR_NAMES.has(error.name) ? error.name : '_OTHER';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}
