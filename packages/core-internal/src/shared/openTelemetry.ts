import type { Attributes, Context, Histogram, Link, MeterProvider, Span, TextMapGetter } from '@opentelemetry/api';
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

import { SUPPORTED_PROTOCOL_VERSIONS } from '../types/index';
import type { InboundOperation, OperationBase, OperationOutcome, OutboundOperation, ProtocolInstrumentation } from './instrumentation';
import { SUPPORTED_MODERN_PROTOCOL_VERSIONS } from './protocolEras';

/** Bucket boundaries the MCP semantic conventions specify for every MCP duration histogram. */
const DURATION_BUCKETS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

/** Codes the conventions say a receiver should not treat as errors: the caller sent something it could not serve. */
const NOT_RECEIVER_ERRORS = new Set([-32_700, -32_600, -32_601, -32_602, -32_002]);
const INVALID_PARAMS = -32_602;

const RESOURCE_URI_METHODS = new Set(['resources/read', 'resources/subscribe', 'resources/unsubscribe', 'notifications/resources/updated']);

/** Log notifications are deprecated (SEP-2577) and belong in logs, not spans. */
const SKIPPED_METHODS = new Set(['notifications/message']);

/** Protocol versions a receiver may record before negotiation; anything else a client sends is unbounded. */
const KNOWN_PROTOCOL_VERSIONS = new Set([...SUPPORTED_PROTOCOL_VERSIONS, ...SUPPORTED_MODERN_PROTOCOL_VERSIONS]);

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

// MCP spans, duration histograms and `_meta` trace context through the global OpenTelemetry API.
export function openTelemetryInstrumentation(scopeName: string): ProtocolInstrumentation {
    const tracer = trace.getTracer(scopeName);

    // Recreated when the global meter provider changes: the metrics API has no proxy, so instruments from an earlier provider stay no-ops.
    let durations: Record<Side, Histogram> | undefined;
    let durationsProvider: MeterProvider | undefined;
    const duration = (side: Side): Histogram => {
        const provider = metrics.getMeterProvider();
        if (durations === undefined || durationsProvider !== provider) {
            durationsProvider = provider;
            const meter = provider.getMeter(scopeName);
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

    const extract = (ctx: Context, carrier: Readonly<Record<string, unknown>>) => propagation.extract(ctx, carrier, metaGetter);

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
                }
                break;
            }
            case 'error': {
                const { code, message } = outcome.error;
                span.setAttribute('rpc.response.status_code', String(code));
                // A server can answer with any code; outside the JSON-RPC reserved range it is bucketed on the client's metrics.
                const metricCode = side === 'client' && !isReservedErrorCode(code) ? '_OTHER' : String(code);
                metricAttributes['rpc.response.status_code'] = metricCode;
                if (side === 'client' || !NOT_RECEIVER_ERRORS.has(code)) {
                    errorType = String(code);
                    metricAttributes['error.type'] = metricCode;
                    span.setStatus({ code: SpanStatusCode.ERROR, message });
                    if (side === 'server' && isUnexpectedException(outcome.cause)) span.recordException(outcome.cause);
                }
                break;
            }
            case 'timeout':
            case 'cancelled': {
                errorType = outcome.type;
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
            metricAttributes['error.type'] ??= errorType;
        }
        // On the server a tool or prompt name is client-chosen: keep it only once the handler has recognised it.
        if (side === 'server' && target !== undefined && !recognisedTarget(outcome)) {
            span.updateName(method);
            delete metricAttributes['gen_ai.tool.name'];
            delete metricAttributes['gen_ai.prompt.name'];
        }
        span.end();
        duration(side).record((performance.now() - started) / 1000, metricAttributes);
    };

    return {
        send(operation: OutboundOperation) {
            if (SKIPPED_METHODS.has(operation.method)) return;
            const target = targetOf(operation);
            const attributes = startAttributes(operation, operation.method, target, 'client');
            // Trace context the caller already put in `_meta` parents the span; otherwise the active context does.
            const parent = extract(context.active(), operation.carrier);
            const span = tracer.startSpan(spanName(operation.method, target), { kind: SpanKind.CLIENT, attributes }, parent);
            const spanContext = trace.setSpan(parent, span);
            const injected: Record<string, string> = {};
            // Injected with the span's context active: some propagators (Sentry's) only inject the active context.
            context.with(spanContext, () => propagation.inject(spanContext, injected, defaultTextMapSetter));
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
            // Any other method name is client-chosen: record it as `_OTHER` to bound cardinality.
            const method = operation.knownMethod ? operation.method : '_OTHER';
            const target = operation.knownMethod ? targetOf(operation) : undefined;
            const attributes = startAttributes(operation, method, target, 'server');
            if (operation.httpRequest !== undefined) {
                attributes['network.protocol.name'] = 'http';
                attributes['network.transport'] = 'tcp';
            }
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

function startAttributes(operation: OperationBase, method: string, target: string | undefined, side: Side): Attributes {
    const attributes: Attributes = { 'mcp.method.name': method };
    if (operation.id !== undefined) attributes['jsonrpc.request.id'] = String(operation.id);
    // Before negotiation `initialize` names a version; a receiver only records one it supports.
    const requested = operation.method === 'initialize' ? operation.params?.protocolVersion : undefined;
    const requestedVersion =
        typeof requested === 'string' && (side === 'client' || KNOWN_PROTOCOL_VERSIONS.has(requested)) ? requested : undefined;
    const protocolVersion = operation.protocolVersion ?? requestedVersion;
    if (protocolVersion !== undefined) attributes['mcp.protocol.version'] = protocolVersion;
    if (operation.sessionId !== undefined) attributes['mcp.session.id'] = operation.sessionId;
    if (method === 'tools/call') {
        attributes['gen_ai.operation.name'] = 'execute_tool';
        if (target !== undefined) attributes['gen_ai.tool.name'] = target;
    }
    if (method === 'prompts/get' && target !== undefined) attributes['gen_ai.prompt.name'] = target;
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

/** Whether a handler answered and recognised the tool or prompt: errors sent before dispatch carry no cause, and unknown names answer -32602. */
function recognisedTarget(outcome: OperationOutcome): boolean {
    return outcome.type === 'result' || (outcome.type === 'error' && outcome.cause !== undefined && outcome.error.code !== INVALID_PARAMS);
}

/** JSON-RPC reserves -32768 to -32000; codes outside it are application-defined and unbounded. */
function isReservedErrorCode(code: number): boolean {
    return Number.isInteger(code) && code >= -32_768 && code <= -32_000;
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
