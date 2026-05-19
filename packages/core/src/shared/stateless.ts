import type {
    AuthInfo,
    ClientCapabilities,
    Implementation,
    InputRequests,
    InputResponses,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    LoggingLevel
} from '../types/index.js';

/**
 * Closed list of protocol versions that use the legacy stateful model
 * (`initialize` handshake, per-connection state). Any version not in this list
 * is treated as stateless (per-request `_meta`).
 *
 * Hardcoded by design. Do NOT derive from `SUPPORTED_PROTOCOL_VERSIONS`: when
 * `2026-06-18` is added there, a derived list would silently classify it as
 * stateful and misroute every request. New stateful versions are not expected;
 * if one ever ships, add it here explicitly.
 */
export const STATEFUL_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/**
 * Returns true when the given protocol-version string is one the SDK should
 * serve via the stateless dispatch path (per-request `_meta`, no `initialize`).
 */
export function isStatelessProtocolVersion(version: string): boolean {
    return version.length > 0 && !STATEFUL_PROTOCOL_VERSIONS.includes(version);
}

/**
 * RPC method names removed in the 2026-06 stateless model. A stateless server
 * returns `-32601 MethodNotFound` for these.
 */
export const STATELESS_REMOVED_METHODS: ReadonlySet<string> = new Set([
    'initialize',
    'ping',
    'logging/setLevel',
    'resources/subscribe',
    'resources/unsubscribe'
]);

/**
 * Reserved `_meta` keys under the `io.modelcontextprotocol/` namespace.
 */
export const META_KEYS = {
    protocolVersion: 'io.modelcontextprotocol/protocolVersion',
    clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
    clientInfo: 'io.modelcontextprotocol/clientInfo',
    logLevel: 'io.modelcontextprotocol/logLevel',
    subscriptionId: 'io.modelcontextprotocol/subscriptionId'
} as const;

/**
 * Per-request client state extracted from a request's `params`. All fields are
 * client-asserted advisory data, not authentication; a malformed value is
 * indistinguishable from a well-formed lie. Authorization is at the transport
 * layer.
 */
export interface ClientMeta {
    protocolVersion?: string;
    clientCapabilities?: ClientCapabilities;
    clientInfo?: Implementation;
    logLevel?: LoggingLevel;
    /** From `params.inputResponses` (spec `InputResponseRequestParams`), not `_meta`. */
    inputResponses?: InputResponses;
    /** From `params.requestState` (spec `InputResponseRequestParams`), not `_meta`. */
    requestState?: string;
}

/**
 * Reads the SEP-2575/2322 per-request keys from `params`: namespaced
 * `io.modelcontextprotocol/*` keys from `params._meta`, plus `inputResponses`
 * and `requestState` from `params` itself (spec `InputResponseRequestParams`).
 * Top-level type checks only; unknown keys ignored. See the security note on
 * {@linkcode ClientMeta}.
 */
export function parseClientMeta(
    params: { _meta?: Record<string, unknown>; inputResponses?: unknown; requestState?: unknown } | undefined
): ClientMeta {
    const out: ClientMeta = {};
    const meta = params?._meta;
    if (meta && typeof meta === 'object') {
        const v = meta[META_KEYS.protocolVersion];
        if (typeof v === 'string') out.protocolVersion = v;
        // Client-asserted advisory state, not auth; malformed = well-formed lie.
        // clientCapabilities declares what the CLIENT supports; lying only hurts the client.
        const caps = meta[META_KEYS.clientCapabilities];
        if (caps && typeof caps === 'object') out.clientCapabilities = caps as ClientCapabilities;
        const info = meta[META_KEYS.clientInfo];
        if (info && typeof info === 'object') out.clientInfo = info as Implementation;
        const lvl = meta[META_KEYS.logLevel];
        if (typeof lvl === 'string') out.logLevel = lvl as LoggingLevel;
    }
    // SEP-2322: inputResponses + requestState live at params-level, not in _meta.
    if (params?.inputResponses && typeof params.inputResponses === 'object') {
        out.inputResponses = params.inputResponses as InputResponses;
    }
    if (typeof params?.requestState === 'string') out.requestState = params.requestState;
    return out;
}

/**
 * Returns true when the message is a JSON-RPC request whose `_meta` carries a
 * stateless protocol version. This is the per-message routing predicate used by
 * transport bridges.
 */
export function isStatelessRequest(msg: unknown): msg is JSONRPCRequest {
    if (!msg || typeof msg !== 'object' || !('method' in msg) || !('id' in msg)) return false;
    const v = parseClientMeta((msg as { params?: { _meta?: Record<string, unknown> } }).params).protocolVersion;
    return typeof v === 'string' && isStatelessProtocolVersion(v);
}

/**
 * Thrown by a tool/prompt handler running under the stateless dispatch path to
 * indicate it needs additional client input (sampling, elicitation, roots)
 * before it can produce a final result. The dispatcher catches this and returns
 * an `InputRequiredResult`; the client retries with `inputResponses` in params.
 *
 * Handler code does not normally throw this directly; the `ctx.mcpReq.elicitInput`
 * (etc.) helpers throw it when no cached response is available.
 */
export class InputRequiredError extends Error {
    constructor(
        readonly inputRequests: InputRequests,
        readonly requestState?: string
    ) {
        super('input required');
        this.name = 'InputRequiredError';
    }

    /**
     * Returns the top-level client capability names this set of input requests
     * requires. Used for the `-32003` cap-gate before returning `InputRequiredResult`.
     */
    requiredCapabilities(): string[] {
        const caps = new Set<string>();
        for (const r of Object.values(this.inputRequests)) {
            switch (r.method) {
                case 'sampling/createMessage': {
                    caps.add('sampling');
                    break;
                }
                case 'elicitation/create': {
                    caps.add('elicitation');
                    break;
                }
                case 'roots/list': {
                    caps.add('roots');
                    break;
                }
            }
        }
        return [...caps];
    }
}

/** Type guard for {@linkcode InputRequiredError}. */
export function isInputRequiredError(e: unknown): e is InputRequiredError {
    return e instanceof InputRequiredError;
}

/**
 * Per-request context the caller (transport adapter or `handleHttp`) provides
 * to the stateless dispatch path. Everything is request-scoped; there is no
 * connection state.
 */
export interface DispatchContext {
    /** Aborts the handler if the caller disconnects or cancels. */
    signal?: AbortSignal;
    /** Validated authorization info from the transport layer (HTTP only). */
    authInfo?: AuthInfo;
    /** The original HTTP `Request` (HTTP only). */
    httpRequest?: globalThis.Request;
    /**
     * Pre-parsed `_meta` for this request. Callers that already ran
     * {@linkcode parseClientMeta} (e.g. for validation) pass the result here so
     * the server does not parse again. Omit to have it parsed from
     * `request.params._meta`.
     */
    meta?: ClientMeta;
    /**
     * Called for each notification the handler emits via `ctx.mcpReq.notify`
     * or `ctx.mcpReq.log`. The caller writes these to the response stream
     * immediately (real time, not buffered). MUST NOT throw.
     */
    notify(notification: JSONRPCNotification): void;
}

/**
 * Per-listen context a transport supplies when opening a `subscriptions/listen`
 * stream. Everything is request-scoped.
 */
export interface ListenContext {
    /** Validated authorization info from the transport layer (HTTP only). */
    authInfo?: AuthInfo;
    /**
     * Decides whether the requesting client may subscribe to updates for a
     * specific resource URI. If absent, all `resourceSubscriptions` are denied
     * (fail-closed).
     */
    onAuthorizeResourceSubscription?: (uri: string, ctx: { authInfo?: AuthInfo }) => boolean;
}

/**
 * The result of opening a `subscriptions/listen` stream. The caller iterates
 * `stream` (the first message is always `notifications/subscriptions/acknowledged`)
 * and calls `close()` on disconnect/abort to release the registration.
 */
export interface ListenStream {
    stream: AsyncIterable<JSONRPCMessage>;
    close(): void;
}

/**
 * The two function shapes a server-side transport needs to handle 2026-06
 * stateless requests. `dispatch` is request→response (always short-lived);
 * `listen` is request→stream (`subscriptions/listen` only). Installed on the
 * transport via {@linkcode Transport.setStatelessHandlers}.
 */
export interface StatelessHandlers {
    dispatch(request: JSONRPCRequest, ctx: DispatchContext): Promise<JSONRPCResponse | JSONRPCErrorResponse>;
    listen(request: JSONRPCRequest, ctx: ListenContext): ListenStream;
}
