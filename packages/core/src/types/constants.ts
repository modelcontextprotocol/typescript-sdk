export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/**
 * The wire identifier of the draft (unreleased) protocol revision.
 *
 * The literal mirrors `LATEST_PROTOCOL_VERSION` in the draft specification schema
 * (https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/draft/schema.ts),
 * which is the source of truth for this value.
 *
 * Draft protocol versions are not negotiable and require explicit opt-in: they never appear in
 * {@linkcode SUPPORTED_PROTOCOL_VERSIONS}, and listing one in `supportedProtocolVersions`
 * additionally requires the `allowDraftVersions` option to be `true` (otherwise construction throws).
 */
export const DRAFT_PROTOCOL_VERSION_2026 = 'DRAFT-2026-v1';

/**
 * All draft (unreleased) protocol revisions known to this SDK.
 *
 * Draft versions are kept separate from {@linkcode SUPPORTED_PROTOCOL_VERSIONS}: they are never
 * negotiated or served by default, and may only be listed in `supportedProtocolVersions` together
 * with the explicit `allowDraftVersions` opt-in.
 */
export const DRAFT_PROTOCOL_VERSIONS: readonly string[] = [DRAFT_PROTOCOL_VERSION_2026];

export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
