/**
 * Connect-time protocol version negotiation (opt-in via
 * `ClientOptions.versionNegotiation`): the option surface, the probe window (a
 * raw transport exchange run before the Protocol machinery attaches), and the
 * negotiation engine driving the pure {@linkcode classifyProbeOutcome} classifier.
 *
 * Invariants: the probe uses string ids and consumes no Protocol message ids, so
 * a legacy fallback's `initialize` is byte-equivalent to a plain legacy connect;
 * the transport's protocol-version slot is never mutated during negotiation
 * (probe headers derive from the probe message body) and is set exactly once
 * after a modern resolution; while the probe window is open, inbound messages
 * that are not the probe response are dropped with zero bytes written back.
 */
import type { ClientCapabilities, DiscoverResult, Implementation, JSONRPCRequest, Transport } from '@modelcontextprotocol/core';
import {
    codecForVersion,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    isModernProtocolVersion,
    legacyProtocolVersions,
    modernProtocolVersions,
    SdkError,
    SdkErrorCode,
    SdkHttpError,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';

import type { ProbeEnvironment, ProbeOutcome, ProbeTransportKind, ProbeVerdict } from './probeClassifier.js';
import { classifyProbeOutcome } from './probeClassifier.js';

/**
 * Probe policy for `'auto'` and pinned negotiation modes.
 *
 * There is no special probe timeout opinion: the probe inherits the client's
 * STANDARD request timeout unless `timeoutMs` overrides it.
 */
export interface VersionNegotiationProbeOptions {
    /**
     * Timeout for the probe exchange, in milliseconds.
     *
     * The timeout verdict is transport-aware: on stdio, a probe that gets no
     * response within the timeout indicates a legacy server and falls back to
     * the `initialize` handshake on the same stream; on HTTP, where a deployed
     * server answers and silence means an outage, `connect()` rejects with the
     * standard typed timeout error instead.
     *
     * @default the standard request timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC`, or the `timeout` passed to `connect()`)
     */
    timeoutMs?: number;

    /**
     * Number of times to re-send the probe after a timeout before reaching the
     * timeout verdict. Governs timeout re-sends only — the spec-mandated
     * `-32022` corrective continuation (select-and-continue with a mutual
     * version) is a separate negotiation step and is never counted against
     * `maxRetries`.
     *
     * @default 0 (no retries)
     */
    maxRetries?: number;
}

/**
 * Negotiation mode:
 *
 * - `'legacy'` — no negotiation: the plain 2025 connect sequence, byte-identical
 *   to a client without this option.
 * - `'auto'` — probe with `server/discover` at connect; conservative fallback to
 *   the plain legacy `initialize` handshake on the same connection unless the
 *   outcome is definitive modern evidence. Network outage rejects with a typed
 *   connect error; a probe timeout falls back to `initialize` on stdio (a silent
 *   server on a local pipe is a legacy server) and rejects with a typed timeout
 *   error on HTTP (silence there is an outage).
 * - `{ pin: '<version>' }` — modern era at exactly the pinned revision: the
 *   connect-time `server/discover` must offer it. No fallback — anything else
 *   fails loudly with a typed error.
 */
export type VersionNegotiationMode = 'legacy' | 'auto' | { pin: string };

/**
 * Opt-in protocol version negotiation, configured on
 * `ClientOptions.versionNegotiation`.
 */
export interface VersionNegotiationOptions {
    /**
     * @default 'legacy'
     */
    mode?: VersionNegotiationMode;

    /**
     * Probe timeout/retry policy (only consulted by the probing modes).
     */
    probe?: VersionNegotiationProbeOptions;
}

/**
 * The default mode when `versionNegotiation` (or its `mode`) is absent;
 * changing the default later is a flip of this single line.
 */
const DEFAULT_VERSION_NEGOTIATION_MODE: VersionNegotiationMode = 'legacy';

/** A fully resolved negotiation plan for one `connect()` call. */
export type ResolvedVersionNegotiation =
    | { kind: 'legacy' }
    | {
          kind: 'auto';
          /** Modern versions this client offers, in preference order (never empty). */
          modernVersions: string[];
          /** Whether this client can fall back to the legacy `initialize` handshake. */
          fallbackAvailable: boolean;
          probe: VersionNegotiationProbeOptions;
      }
    | { kind: 'pin'; version: string; probe: VersionNegotiationProbeOptions };

/**
 * Resolve the negotiation options into a per-connect plan. The raw (not
 * defaulted) `supportedProtocolVersions` option supplies the modern offer list;
 * a list without any legacy version makes this a modern-only client (no fallback).
 */
export function resolveVersionNegotiation(
    options: VersionNegotiationOptions | undefined,
    supportedProtocolVersionsOption: readonly string[] | undefined
): ResolvedVersionNegotiation {
    const mode = options?.mode ?? DEFAULT_VERSION_NEGOTIATION_MODE;
    if (mode === 'legacy') {
        return { kind: 'legacy' };
    }
    const probe = options?.probe ?? {};
    if (typeof mode === 'object') {
        if (!isModernProtocolVersion(mode.pin)) {
            throw new TypeError(
                `versionNegotiation: { pin: '${mode.pin}' } is not a modern protocol revision — ` +
                    `pinning is for 2026-07-28 and later; omit versionNegotiation (or use mode: 'legacy') for 2025-era servers.`
            );
        }
        return { kind: 'pin', version: mode.pin, probe };
    }
    const explicitModern = supportedProtocolVersionsOption ? modernProtocolVersions(supportedProtocolVersionsOption) : [];
    const modernVersions = explicitModern.length > 0 ? explicitModern : [...SUPPORTED_MODERN_PROTOCOL_VERSIONS];
    const fallbackAvailable = supportedProtocolVersionsOption ? legacyProtocolVersions(supportedProtocolVersionsOption).length > 0 : true;
    return { kind: 'auto', modernVersions, fallbackAvailable, probe };
}

/** Detect the probe environment for the network-failure row — see {@linkcode ProbeEnvironment}. */
export function detectProbeEnvironment(): ProbeEnvironment {
    const g = globalThis as { window?: unknown; document?: unknown };
    return g.window !== undefined && g.document !== undefined ? 'browser' : 'node';
}

/**
 * Detect the transport class for the transport-aware timeout verdict (see
 * {@linkcode ProbeTransportKind}). The stdio child-process transport is
 * recognized structurally (`stderr`/`pid` accessors, no `instanceof` — safe
 * across bundles); everything else is treated like HTTP.
 */
export function detectProbeTransportKind(transport: Transport): ProbeTransportKind {
    return 'stderr' in transport && 'pid' in transport ? 'stdio' : 'http';
}

/** Raw reply from one probe exchange, before normalization. */
type RawProbeReply =
    | { kind: 'response'; result?: unknown; error?: { code: number; message: string; data?: unknown } }
    | { kind: 'send-error'; error: unknown }
    | { kind: 'closed' }
    | { kind: 'timeout' };

/**
 * Temporary ownership of a raw transport for the negotiation exchange, before
 * the Protocol machinery attaches. `open()` installs the window's handlers and
 * starts the transport; `release()` detaches them and arms a one-shot `start()`
 * pass-through so the subsequent Protocol connect (which always starts its
 * transport) takes over the already-started channel without a double-start error.
 */
class ProbeWindow {
    private _pending: { id: string; resolve: (reply: RawProbeReply) => void } | undefined;
    private _probeCounter = 0;

    private constructor(private readonly _transport: Transport) {}

    static async open(transport: Transport): Promise<ProbeWindow> {
        const window = new ProbeWindow(transport);
        transport.onmessage = message => {
            const pending = window._pending;
            if (
                pending !== undefined &&
                (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
                message.id === pending.id
            ) {
                window._pending = undefined;
                if (isJSONRPCResultResponse(message)) {
                    pending.resolve({ kind: 'response', result: message.result });
                } else {
                    pending.resolve({ kind: 'response', error: message.error });
                }
                return;
            }
            // Probe-window guard: drop everything else with zero bytes written back (see module doc).
        };
        transport.onerror = () => {
            // Out-of-band transport errors are not necessarily fatal; the probe
            // resolves via a send failure, the close signal, or the timeout.
        };
        transport.onclose = () => {
            const pending = window._pending;
            if (pending !== undefined) {
                window._pending = undefined;
                pending.resolve({ kind: 'closed' });
            }
        };
        await transport.start();
        return window;
    }

    /**
     * Send one probe request and await its reply. Probe ids are strings, so they
     * never collide with Protocol's numeric ids (e.g. on a shared stdio pipe).
     */
    async exchange(buildRequest: (id: string) => JSONRPCRequest, timeoutMs: number): Promise<RawProbeReply> {
        const id = `server-discover-probe-${++this._probeCounter}`;
        return new Promise<RawProbeReply>(resolve => {
            let settled = false;
            const settle = (reply: RawProbeReply) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (this._pending?.id === id) {
                    this._pending = undefined;
                }
                resolve(reply);
            };
            const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
            this._pending = { id, resolve: settle };
            this._transport.send(buildRequest(id)).catch((error: unknown) => settle({ kind: 'send-error', error }));
        });
    }

    /** Detach the window's handlers, leaving the transport's own `start` untouched. */
    detach(): void {
        this._pending = undefined;
        this._transport.onmessage = undefined;
        this._transport.onerror = undefined;
        this._transport.onclose = undefined;
    }

    /** Detach the handlers and arm the one-shot `start()` pass-through for the `Protocol.connect()` handover. */
    release(): void {
        this.detach();
        const transport = this._transport;
        const originalStart = transport.start.bind(transport);
        let armed = true;
        transport.start = async (): Promise<void> => {
            if (armed) {
                armed = false;
                transport.start = originalStart;
                return;
            }
            return originalStart();
        };
    }
}

/** Build the probe request: `server/discover` carrying the full per-request `_meta` envelope. */
export function buildProbeRequest(
    id: string,
    protocolVersion: string,
    clientInfo: Implementation,
    capabilities: ClientCapabilities
): JSONRPCRequest {
    return {
        jsonrpc: '2.0',
        id,
        method: 'server/discover',
        params: {
            // The era codec owns the keyed-envelope shape; the probe is sent
            // for a modern version, so this is always the 2026 envelope.
            _meta: codecForVersion(protocolVersion).outboundEnvelope({
                protocolVersion,
                clientInfo,
                clientCapabilities: capabilities
            })
        }
    };
}

function normalizeReply(reply: RawProbeReply, timeoutMs: number): ProbeOutcome {
    switch (reply.kind) {
        case 'response': {
            return reply.error === undefined ? { kind: 'result', result: reply.result } : { kind: 'rpc-error', ...reply.error };
        }
        case 'send-error': {
            const error = reply.error;
            if (error instanceof SdkHttpError) {
                const text = (error.data as { text?: unknown } | undefined)?.text;
                return { kind: 'http-error', status: error.data.status, body: typeof text === 'string' ? text : undefined };
            }
            if (error instanceof Error && error.name === 'UnauthorizedError') {
                // Auth-gated server: not era evidence — the conservative legacy
                // fallback re-runs the auth flow through the plain connect path.
                return { kind: 'http-error', status: 401 };
            }
            return { kind: 'network-error', error };
        }
        case 'closed': {
            return { kind: 'network-error', error: new Error('Connection closed during the version negotiation probe') };
        }
        case 'timeout': {
            return { kind: 'timeout', timeoutMs };
        }
    }
}

export interface NegotiationDeps {
    transport: Transport;
    clientInfo: Implementation;
    capabilities: ClientCapabilities;
    environment: ProbeEnvironment;
    /** The transport class, for the transport-aware timeout verdict (see {@linkcode ProbeTransportKind}). */
    transportKind: ProbeTransportKind;
    /** The standard request timeout for this connect (probe inherits it unless `probe.timeoutMs` overrides). */
    defaultTimeoutMs: number;
}

export type NegotiationResult = { era: 'modern'; version: string; discover: DiscoverResult } | { era: 'legacy' };

/**
 * Run the negotiation probe state machine on a raw (not yet Protocol-connected)
 * transport. Resolves with the negotiated era; throws typed connect errors. On
 * return the probe window has been released: the transport is started,
 * handler-free, and ready for `Protocol.connect()` handover. On throw the
 * window is detached and the transport's `start` is left untouched.
 */
export async function negotiateEra(
    negotiation: Extract<ResolvedVersionNegotiation, { kind: 'auto' | 'pin' }>,
    deps: NegotiationDeps
): Promise<NegotiationResult> {
    const timeoutMs = negotiation.probe.timeoutMs ?? deps.defaultTimeoutMs;
    const maxRetries = Math.max(0, negotiation.probe.maxRetries ?? 0);
    const clientModernVersions = negotiation.kind === 'pin' ? [negotiation.version] : negotiation.modernVersions;
    const fallbackAvailable = negotiation.kind === 'auto' && negotiation.fallbackAvailable;

    const window = await ProbeWindow.open(deps.transport);

    const probe = async (): Promise<NegotiationResult> => {
        let requestedVersion = clientModernVersions[0]!;
        // The -32022 corrective continuation runs exactly once (even when the
        // mutual version equals the just-rejected one); the loop guard arms on
        // the second rejection.
        let correctiveUsed = false;
        // `maxRetries` governs timeout re-sends only — independent of (and
        // never counted against) the corrective continuation.
        let timeoutRetriesRemaining = maxRetries;
        for (;;) {
            const reply = await window.exchange(
                id => buildProbeRequest(id, requestedVersion, deps.clientInfo, deps.capabilities),
                timeoutMs
            );

            if (reply.kind === 'timeout' && timeoutRetriesRemaining > 0) {
                timeoutRetriesRemaining--;
                continue;
            }

            const outcome = normalizeReply(reply, timeoutMs);
            const verdict: ProbeVerdict = classifyProbeOutcome(outcome, {
                clientModernVersions,
                requestedVersion,
                fallbackAvailable,
                environment: deps.environment,
                transportKind: deps.transportKind
            });

            switch (verdict.kind) {
                case 'modern': {
                    return { era: 'modern', version: verdict.version, discover: verdict.discover };
                }
                case 'corrective': {
                    if (correctiveUsed) {
                        // Second rejection: loop guard.
                        throw verdict.error;
                    }
                    correctiveUsed = true;
                    requestedVersion = verdict.version;
                    continue;
                }
                case 'legacy': {
                    if (negotiation.kind === 'pin') {
                        throw new SdkError(
                            SdkErrorCode.EraNegotiationFailed,
                            `Version negotiation failed: the server did not offer pinned protocol version ${negotiation.version} ` +
                                `via server/discover (no fallback in pin mode)`
                        );
                    }
                    if (!negotiation.fallbackAvailable) {
                        // Modern-only client: the legacy initialize fallback is
                        // unavailable and must never carry a 2026-era version string.
                        throw new SdkError(
                            SdkErrorCode.EraNegotiationFailed,
                            'Version negotiation failed: the server gave no modern evidence and this client supports no ' +
                                'pre-2026-07-28 protocol version to fall back to'
                        );
                    }
                    return { era: 'legacy' };
                }
                case 'error': {
                    throw verdict.error;
                }
            }
        }
    };

    let result: NegotiationResult;
    try {
        result = await probe();
    } catch (error) {
        // A failed negotiation leaves the transport exactly as it found it:
        // handlers detached, original start untouched (no pass-through armed).
        window.detach();
        throw error;
    }
    window.release();
    return result;
}
