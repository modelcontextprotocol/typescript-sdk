/**
 * Probe outcome classifier (pure module): maps the outcome of the connect-time
 * `server/discover` probe onto one of four verdicts — modern era, the
 * spec-mandated `-32022` corrective continuation, legacy fallback (the plain
 * 2025 `initialize` handshake on the same connection), or a typed connect error.
 *
 * The classifier is deliberately conservative: anything it does not positively
 * recognize as modern resolves to the legacy fallback, and a network outage is a
 * typed connect error, never an era verdict. The verdicts apply to the
 * negotiation phase only — an established modern connection is never silently
 * demoted to `initialize` by a later failure.
 */
import type { DiscoverResult } from '@modelcontextprotocol/core';
import {
    DiscoverResultSchema,
    modernProtocolVersions,
    SdkError,
    SdkErrorCode,
    UnsupportedProtocolVersionError
} from '@modelcontextprotocol/core';

/**
 * The runtime environment the probe executed in. Only consulted for the
 * network-failure row: a browser CORS-preflight rejection is treated as a
 * legacy signal, while in Node a network failure stays a typed connect error.
 */
export type ProbeEnvironment = 'node' | 'browser';

/**
 * The transport class the probe ran on. Only consulted for the timeout row: a
 * stdio probe that times out signals a legacy server, while an HTTP timeout
 * stays a typed error. Anything that is not the stdio child-process transport
 * is treated like HTTP.
 */
export type ProbeTransportKind = 'stdio' | 'http';

/**
 * A normalized probe outcome, produced by the connect-time wiring from the raw
 * transport exchange.
 */
export type ProbeOutcome =
    | { kind: 'result'; result: unknown }
    /** Answered with a JSON-RPC error (any HTTP status, including 200-bodied errors and stdio in-band errors). */
    | { kind: 'rpc-error'; code: number; message: string; data?: unknown }
    /** The HTTP layer rejected the probe POST (non-2xx); `body` is the raw response text, when available. */
    | { kind: 'http-error'; status: number; body?: string }
    | { kind: 'network-error'; error: unknown }
    /** No response arrived within the probe timeout. */
    | { kind: 'timeout'; timeoutMs: number };

export interface ProbeClassifierContext {
    /** Modern-era versions this client can negotiate, in preference order (never empty). */
    clientModernVersions: readonly string[];
    /** The version the probe carried in its `_meta` envelope (used to synthesize `data.requested` on typed errors). */
    requestedVersion: string;
    /**
     * Whether a legacy `initialize` fallback is possible — `false` for a
     * modern-only client and for `pin` mode. Without a fallback, rows carrying
     * modern evidence but no usable version overlap — a `DiscoverResult` with
     * no overlapping version, or a `-32022` whose `data.supported` lists only
     * legacy revisions — yield a typed `UnsupportedProtocolVersionError` built
     * from that evidence; the remaining rows that would have fallen back still
     * classify as `legacy`, and the caller reports them as a typed negotiation
     * error instead of starting an `initialize` handshake.
     */
    fallbackAvailable: boolean;
    /** See {@linkcode ProbeEnvironment}. */
    environment: ProbeEnvironment;
    /** See {@linkcode ProbeTransportKind}. */
    transportKind: ProbeTransportKind;
}

export type ProbeVerdict =
    /** Definitive modern evidence: select `version` and continue without `initialize`. */
    | { kind: 'modern'; version: string; discover: DiscoverResult }
    /**
     * `-32022` with a mutual modern version: re-send the probe at `version`.
     * Spec-mandated select-and-continue — the caller runs it exactly once and
     * arms a loop guard on the second rejection, throwing `error`.
     */
    | { kind: 'corrective'; version: string; error: UnsupportedProtocolVersionError }
    /** Definitive legacy signal or unrecognized shape: perform the plain legacy `initialize` handshake on the same connection. */
    | { kind: 'legacy' }
    /** Typed connect error — never converted to an era verdict. */
    | { kind: 'error'; error: Error };

/** The `-32022` UnsupportedProtocolVersion protocol error code (negotiation-phase recognition). */
const UNSUPPORTED_PROTOCOL_VERSION = -32_022;
/**
 * Deliberately not probe-recognized in either direction: deployed servers
 * overload `-32001` (the SDK-conventional `Session not found` body on a 2025
 * stateful server), and the spec-assigned `-32020` (`HeaderMismatch`) /
 * `-32021` (`MissingRequiredClientCapability`) are not era evidence — all
 * fall into the conservative legacy default.
 */
const NOT_PROBE_RECOGNIZED = new Set([-32_001, -32_020, -32_021]);

/**
 * Classify a single probe outcome. Pure: no I/O, no state — loop-guard and
 * retry state live in the caller.
 */
export function classifyProbeOutcome(outcome: ProbeOutcome, context: ProbeClassifierContext): ProbeVerdict {
    switch (outcome.kind) {
        case 'result': {
            return classifyResult(outcome.result, context);
        }
        case 'rpc-error': {
            return classifyRpcError(outcome, context);
        }
        case 'http-error': {
            return classifyHttpError(outcome, context);
        }
        case 'network-error': {
            return classifyNetworkError(outcome.error, context);
        }
        case 'timeout': {
            if (context.transportKind === 'stdio') {
                // Per the stdio transport's backward-compatibility rule, a probe
                // nobody answers within the timeout indicates a legacy server —
                // fall back to `initialize` on the same stream.
                return { kind: 'legacy' };
            }
            // On HTTP a deployed server answers, so silence is an outage, not a
            // legacy signal: keep the typed timeout error (the compatibility
            // matrix keys the HTTP legacy signal to a 4xx, never to silence).
            return {
                kind: 'error',
                error: new SdkError(SdkErrorCode.RequestTimeout, `Version negotiation probe timed out after ${outcome.timeoutMs}ms`, {
                    timeout: outcome.timeoutMs
                })
            };
        }
    }
}

function classifyResult(result: unknown, context: ProbeClassifierContext): ProbeVerdict {
    const parsed = DiscoverResultSchema.safeParse(result);
    if (!parsed.success) {
        // Unrecognized result shape: not modern evidence — conservative legacy fallback.
        return { kind: 'legacy' };
    }
    const supportedVersions = parsed.data.supportedVersions;
    const overlap = context.clientModernVersions.find(version => supportedVersions.includes(version));
    if (overlap !== undefined) {
        return { kind: 'modern', version: overlap, discover: parsed.data };
    }
    // A DiscoverResult with no overlap still drives era selection: initialize on
    // the same connection when fallback is possible, otherwise a typed error.
    if (context.fallbackAvailable) {
        return { kind: 'legacy' };
    }
    return {
        kind: 'error',
        error: new UnsupportedProtocolVersionError({ supported: [...supportedVersions], requested: context.requestedVersion })
    };
}

function classifyRpcError(outcome: { code: number; message: string; data?: unknown }, context: ProbeClassifierContext): ProbeVerdict {
    const { code, message, data } = outcome;

    if (code === UNSUPPORTED_PROTOCOL_VERSION) {
        const supported = parseSupportedList(data);
        if (supported === undefined) {
            // -32022 without a valid data.supported list is not actionable modern evidence.
            return { kind: 'legacy' };
        }
        const requested = parseRequested(data) ?? context.requestedVersion;
        const error = new UnsupportedProtocolVersionError({ supported, requested }, message);
        const supportedModern = modernProtocolVersions(supported);
        const mutual = context.clientModernVersions.find(version => supportedModern.includes(version));
        if (mutual !== undefined) {
            // Mutual modern version: spec-mandated select-and-continue — never
            // fall back to initialize here.
            return { kind: 'corrective', version: mutual, error };
        }
        if (supportedModern.length > 0) {
            // Disjoint-but-modern list: typed error, never initialize.
            return { kind: 'error', error };
        }
        // Legacy-only list: definitive legacy signal (typed error for a modern-only client).
        return context.fallbackAvailable ? { kind: 'legacy' } : { kind: 'error', error };
    }

    if (NOT_PROBE_RECOGNIZED.has(code)) {
        return { kind: 'legacy' };
    }

    // Everything else — -32601, the deployed -32000 literals/free-text, code 0,
    // any unrecognized code — is a legacy signal or the conservative default.
    return { kind: 'legacy' };
}

function classifyHttpError(outcome: { status: number; body?: string }, context: ProbeClassifierContext): ProbeVerdict {
    // HTTP-rejected probes carry their JSON-RPC error in the response body — classify it like an in-band error.
    const rpcError = parseJsonRpcErrorBody(outcome.body);
    if (rpcError !== undefined) {
        return classifyRpcError(rpcError, context);
    }
    // Unparseable or unrecognized HTTP rejection: conservative legacy fallback.
    return { kind: 'legacy' };
}

function classifyNetworkError(error: unknown, context: ProbeClassifierContext): ProbeVerdict {
    if (context.environment === 'browser' && isOpaqueFetchTypeError(error)) {
        // A browser CORS-preflight rejection against a deployed 2025 server is an
        // opaque TypeError; the legacy fallback carries no custom headers (no
        // preflight), so it can proceed where the probe could not.
        return { kind: 'legacy' };
    }
    return {
        kind: 'error',
        error: new SdkError(SdkErrorCode.EraNegotiationFailed, `Version negotiation probe failed: ${describeError(error)}`, {
            cause: error
        })
    };
}

function isOpaqueFetchTypeError(error: unknown): boolean {
    // Cross-realm safe: a bundled or sandboxed fetch may not share this realm's TypeError identity.
    return error instanceof TypeError || (error instanceof Error && error.name === 'TypeError');
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseSupportedList(data: unknown): string[] | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const supported = (data as { supported?: unknown }).supported;
    if (!Array.isArray(supported) || supported.length === 0 || !supported.every(v => typeof v === 'string')) {
        return undefined;
    }
    return supported as string[];
}

function parseRequested(data: unknown): string | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const requested = (data as { requested?: unknown }).requested;
    return typeof requested === 'string' ? requested : undefined;
}

function parseJsonRpcErrorBody(body: string | undefined): { code: number; message: string; data?: unknown } | undefined {
    if (body === undefined || body === '') return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return undefined;
    const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof code !== 'number') return undefined;
    return { code, message: typeof message === 'string' ? message : '', data };
}
