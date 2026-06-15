/**
 * Probe outcome classifier — the merged fallback table (pure module).
 *
 * Classifies the outcome of the version-negotiation probe (`server/discover` sent
 * at connect time) into one of four verdicts: modern era (select a version), a
 * spec-mandated corrective continuation (`-32004` with a mutual modern version),
 * legacy fallback (perform the plain 2025 `initialize` handshake on the same
 * connection), or a typed connect error.
 *
 * The classifier is deliberately **conservative**: anything it does not positively
 * recognize as modern resolves to the legacy fallback. Network outage rejects with
 * a typed connect error (never an era verdict). Timeouts are transport-aware: on
 * stdio, a probe that nobody answers within the timeout indicates a legacy server
 * — the stdio transport's backward-compatibility rule ("any other error, or does
 * not respond within a reasonable timeout: the server is legacy"; some legacy
 * servers do not respond to unknown pre-`initialize` requests at all) — and falls
 * back to `initialize` on the same stream. On HTTP a deployed server answers, so
 * silence is an outage, not a legacy signal: the timeout stays a typed connect
 * error (the versioning compatibility matrix keys the HTTP legacy signal to a 4xx
 * without a recognized modern error body, never to silence).
 *
 * **Scope: negotiation phase only.** These verdicts apply exclusively to the
 * connect-time probe exchange. Once a connection's era is established as modern, a
 * later unrecognized failure surfaces to the caller and is never re-classified
 * into a silent demotion to `initialize`; the next fresh `connect()` re-runs
 * negotiation from scratch.
 *
 * `-32001` and `-32003` are deliberately NOT probe-recognized in either direction:
 * deployed servers still overload `-32001` for session-404 bodies and the draft
 * error-code ladder for these cells is still being derived upstream (conformance
 * #336), so both fall into the conservative "unrecognized → legacy" default. A
 * conformant modern server never answers a well-formed discover with either code,
 * so nothing is lost.
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
 * network-failure row (F-7): in a browser, a CORS-preflight rejection against a
 * deployed 2025 server surfaces as an opaque `TypeError` indistinguishable from an
 * outage — but the legacy fallback carries no custom headers (no preflight), so it
 * is treated as a definitive-enough legacy signal. In Node there is no CORS layer,
 * so a network failure stays a typed connect error.
 */
export type ProbeEnvironment = 'node' | 'browser';

/**
 * The transport class the probe ran on. Only consulted for the timeout row:
 * the specification's backward-compatibility rule for stdio treats a probe
 * that gets no response within a reasonable timeout as a legacy-server signal
 * (local pipes; some legacy servers do not respond to unknown
 * pre-`initialize` requests at all), while on HTTP a deployed server answers,
 * so silence is an outage — the HTTP legacy signal is a 4xx without a
 * recognized modern error body. Anything that is not the stdio child-process
 * transport is treated like HTTP (the conservative, typed-error posture).
 */
export type ProbeTransportKind = 'stdio' | 'http';

/**
 * A normalized probe outcome, produced by the connect-time wiring from the raw
 * transport exchange. Wire-real inputs only — the wiring maps transport-thrown
 * HTTP errors, network errors, in-band JSON-RPC responses, and timeouts onto
 * these shapes.
 */
export type ProbeOutcome =
    /** The probe request was answered with a JSON-RPC result. */
    | { kind: 'result'; result: unknown }
    /** The probe request was answered with a JSON-RPC error (any HTTP status, including 200-bodied errors and stdio in-band errors). */
    | { kind: 'rpc-error'; code: number; message: string; data?: unknown }
    /** The HTTP layer rejected the probe POST (non-2xx); `body` is the raw response text, when available. */
    | { kind: 'http-error'; status: number; body?: string }
    /** The probe send failed below HTTP (connection refused, DNS, reset, opaque fetch failure). */
    | { kind: 'network-error'; error: unknown }
    /** No response arrived within the probe timeout, after all timeout re-sends. */
    | { kind: 'timeout'; timeoutMs: number; attempts: number };

export interface ProbeClassifierContext {
    /**
     * Modern-era protocol versions this client can negotiate, in preference order.
     * Never empty.
     */
    clientModernVersions: readonly string[];
    /**
     * The version the probe carried in its `_meta` envelope (used to synthesize
     * `data.requested` on typed errors when the server omitted it).
     */
    requestedVersion: string;
    /**
     * Whether a legacy `initialize` fallback is possible. `false` for a
     * modern-only client and for `pin` mode (no fallback, loud failure): rows
     * whose action would be "initialize on the same connection" yield a typed
     * `UnsupportedProtocolVersionError` (with synthesized data when needed)
     * instead.
     *
     * Note this only affects the two *modern-evidence* rows (DiscoverResult with
     * no overlap; `-32004` with a legacy-only list). The plain conservative rows
     * (`-32601`, legacy 400 shapes, unrecognized) always return `legacy`; the
     * caller maps that verdict per its negotiation mode.
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
     * `-32004` with a mutual modern version: select-and-continue (re-send the
     * probe at `version`). Spec-mandated corrective continuation — the caller
     * runs it exactly once (even when `version` equals the just-rejected one)
     * and arms a loop guard on the second rejection, throwing `error`.
     */
    | { kind: 'corrective'; version: string; error: UnsupportedProtocolVersionError }
    /** Definitive legacy signal or unrecognized shape: perform the plain legacy `initialize` handshake on the same connection. */
    | { kind: 'legacy' }
    /** Typed connect error — never converted to an era verdict. */
    | { kind: 'error'; error: Error };

/** The `-32004` UnsupportedProtocolVersion protocol error code (negotiation-phase recognition). */
const UNSUPPORTED_PROTOCOL_VERSION = -32_004;
/** Codes deliberately not probe-recognized (overloaded on deployed servers / ladder underived pending conformance #336). */
const NOT_PROBE_RECOGNIZED = new Set([-32_001, -32_003]);

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
                // stdio: a probe nobody answers within the timeout (after all
                // `maxRetries` re-sends) indicates a legacy server — the stdio
                // transport's backward-compatibility rule says "any other
                // error, or does not respond within a reasonable timeout: the
                // server is legacy. Fall back to the `initialize` handshake."
                // Some legacy stdio servers do not respond to unknown
                // pre-initialize requests at all; the fallback runs on the
                // same stream.
                return { kind: 'legacy' };
            }
            // HTTP (and anything that is not a local pipe): a deployed server
            // answers, so silence is an outage, not a legacy signal — the
            // timeout (standard request timeout, after all `maxRetries`
            // re-sends) stays a typed connect error. Per the versioning
            // compatibility matrix, the HTTP legacy signal is a 4xx response
            // without a recognized modern error body.
            return {
                kind: 'error',
                error: new SdkError(
                    SdkErrorCode.RequestTimeout,
                    `Version negotiation probe timed out after ${outcome.attempts} attempt(s)`,
                    { timeout: outcome.timeoutMs, attempts: outcome.attempts }
                )
            };
        }
    }
}

function classifyResult(result: unknown, context: ProbeClassifierContext): ProbeVerdict {
    const parsed = DiscoverResultSchema.safeParse(result);
    if (!parsed.success) {
        // 200-processed era-ambiguous first requests / any unrecognized result
        // shape: not modern evidence — conservative legacy fallback.
        return { kind: 'legacy' };
    }
    const supportedVersions = parsed.data.supportedVersions;
    const overlap = context.clientModernVersions.find(version => supportedVersions.includes(version));
    if (overlap !== undefined) {
        return { kind: 'modern', version: overlap, discover: parsed.data };
    }
    // DiscoverResult with NO overlap is still modern evidence — but on a dual-era
    // server it drives era SELECTION: initialize on the SAME connection when
    // fallback is possible; otherwise a typed error with synthesized data.
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
            // -32004 without a valid `data.supported` list is not actionable
            // modern evidence — conservative legacy fallback.
            return { kind: 'legacy' };
        }
        const requested = parseRequested(data) ?? context.requestedVersion;
        const error = new UnsupportedProtocolVersionError({ supported, requested }, message);
        const supportedModern = modernProtocolVersions(supported);
        const mutual = context.clientModernVersions.find(version => supportedModern.includes(version));
        if (mutual !== undefined) {
            // Mutual modern version: select-and-continue. MUST NOT fall back —
            // a server that speaks -32004 with a version list is modern by
            // definition (spec: "Do not fall back").
            return { kind: 'corrective', version: mutual, error };
        }
        if (supportedModern.length > 0) {
            // Disjoint-but-modern list: typed error, never initialize.
            return { kind: 'error', error };
        }
        // Legacy-only list: definitive legacy signal → initialize; a modern-only
        // client gets the typed error carrying `data.supported` instead.
        return context.fallbackAvailable ? { kind: 'legacy' } : { kind: 'error', error };
    }

    if (NOT_PROBE_RECOGNIZED.has(code)) {
        // -32001 / -32003: deliberately not probe-recognized in either direction
        // (see module doc) — falls into the conservative default.
        return { kind: 'legacy' };
    }

    // Everything else is a definitive legacy signal or the conservative default:
    // -32601 (method not found — never modern evidence on the probe, including
    // 200-bodied errors), -32000 with the deployed "Unsupported protocol
    // version" literal, -32000 free-text ("Server not initialized",
    // session-required), `code: 0`, and any unrecognized code.
    return { kind: 'legacy' };
}

function classifyHttpError(outcome: { status: number; body?: string }, context: ProbeClassifierContext): ProbeVerdict {
    // HTTP-rejected probes (400/-32000, 400/-32004, …) carry their JSON-RPC error
    // in the response body — classify the body exactly like an in-band error.
    const rpcError = parseJsonRpcErrorBody(outcome.body);
    if (rpcError !== undefined) {
        return classifyRpcError(rpcError, context);
    }
    // Plain-text/unparseable 400, empty body, 406, or any other unrecognized
    // status: conservative legacy fallback.
    return { kind: 'legacy' };
}

function classifyNetworkError(error: unknown, context: ProbeClassifierContext): ProbeVerdict {
    if (context.environment === 'browser' && isOpaqueFetchTypeError(error)) {
        // F-7 (ruled Q12 exception, PROBE PHASE ONLY): a browser CORS-preflight
        // rejection against a deployed 2025 server is an opaque `TypeError`; the
        // legacy fallback carries no custom headers, so it proceeds where the
        // probe could not. Node outage below stays a typed connect error.
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
    // Cross-realm safe: bundled or sandboxed fetch implementations may not share
    // this realm's TypeError identity.
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
