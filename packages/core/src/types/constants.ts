export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/**
 * Protocol versions that negotiate via the initialize handshake (the stateful model). Closed by
 * design: every revision after 2025-11-25 is stateless and negotiates per-request, never via
 * initialize. Hardcoded — do not derive from {@linkcode SUPPORTED_PROTOCOL_VERSIONS}.
 */
export const STATEFUL_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/**
 * Returns `true` when `version` negotiates via the initialize handshake — one of
 * {@linkcode STATEFUL_PROTOCOL_VERSIONS}.
 */
export function isStatefulProtocolVersion(version: string): boolean {
    return STATEFUL_PROTOCOL_VERSIONS.includes(version);
}

/**
 * Wire identifier of the draft (unreleased) protocol revision, mirroring `LATEST_PROTOCOL_VERSION`
 * in the [draft specification schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/draft/schema.ts).
 */
export const DRAFT_PROTOCOL_VERSION_2026 = 'DRAFT-2026-v1';

/** Draft (unreleased) protocol revisions known to this SDK. Stateless: never negotiated via initialize. */
export const DRAFT_PROTOCOL_VERSIONS = [DRAFT_PROTOCOL_VERSION_2026];

export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
