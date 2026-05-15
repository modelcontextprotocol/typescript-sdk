import type { ClientCapabilities, Implementation, InputResponses, LoggingLevel } from '../types/types.js';

/**
 * Protocol versions that use the legacy stateful model (initialize handshake,
 * connection-scoped capabilities, server push). Any version NOT in this list
 * is treated as stateless (per-request _meta, no handshake, SEP-2575).
 */
export const STATEFUL_PROTOCOL_VERSIONS = ['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] as const;

/**
 * Request methods removed in the stateless model. When `isStateless()` is
 * true, these return `-32601 MethodNotFound` at dispatch, before any handler
 * runs. Legacy mode is unaffected.
 */
export const STATELESS_REMOVED_METHODS: ReadonlySet<string> = new Set([
    'initialize',
    'ping',
    'logging/setLevel',
    'resources/subscribe',
    'resources/unsubscribe'
]);

/** Reserved per-request `_meta` keys defined by SEP-2575 and SEP-2322. */
export const META_KEYS = {
    protocolVersion: 'io.modelcontextprotocol/protocolVersion',
    clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
    clientInfo: 'io.modelcontextprotocol/clientInfo',
    logLevel: 'io.modelcontextprotocol/logLevel',
    subscriptionId: 'io.modelcontextprotocol/subscriptionId',
    inputResponses: 'io.modelcontextprotocol/inputResponses',
    requestState: 'io.modelcontextprotocol/requestState'
} as const;

/**
 * Per-request client state extracted from `_meta` (SEP-2575). All fields
 * optional; a legacy client (negotiating via `initialize`) sends none.
 */
export interface ClientMeta {
    protocolVersion?: string;
    clientCapabilities?: ClientCapabilities;
    clientInfo?: Implementation;
    logLevel?: LoggingLevel;
    /** SEP-2322: client responses to a prior `InputRequiredResult`. */
    inputResponses?: InputResponses;
    /** SEP-2322: opaque state echoed back from a prior `InputRequiredResult`. */
    requestState?: string;
}

/**
 * Reads the four SEP-2575 `io.modelcontextprotocol/*` keys from a request's
 * `_meta`. Only those keys are extracted; other `_meta` content is ignored.
 *
 * Values are taken as sent after a top-level type check. They are
 * client-asserted advisory state (capability gating, log filtering), not auth;
 * a malformed object is no different from a well-formed lie.
 */
export function parseClientMeta(params: { _meta?: Record<string, unknown> } | undefined): ClientMeta {
    const meta = params?._meta;
    if (!meta) return {};
    const out: ClientMeta = {};
    const v = meta[META_KEYS.protocolVersion];
    if (typeof v === 'string') out.protocolVersion = v;
    // clientCapabilities is client-asserted advisory state, not auth: it declares
    // what the CLIENT supports, so a lie only deprives the client of features.
    // Authorization is at the transport layer. A malformed object is no worse
    // than a well-formed lie, so a top-level type check is sufficient here.
    const caps = meta[META_KEYS.clientCapabilities];
    if (caps && typeof caps === 'object') out.clientCapabilities = caps as ClientCapabilities;
    const info = meta[META_KEYS.clientInfo];
    if (info && typeof info === 'object') out.clientInfo = info as Implementation;
    const level = meta[META_KEYS.logLevel];
    if (typeof level === 'string') out.logLevel = level as LoggingLevel;
    const responses = meta[META_KEYS.inputResponses];
    if (responses && typeof responses === 'object') out.inputResponses = responses as InputResponses;
    const state = meta[META_KEYS.requestState];
    if (typeof state === 'string') out.requestState = state;
    return out;
}
