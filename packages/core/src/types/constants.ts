export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/**
 * `_meta` key carrying the JSON-RPC `id` of the parent `events/stream` request
 * on every `notifications/events/*` message, so a client with multiple
 * concurrent streams can route notifications to the correct one. See SEP-2575.
 */
export const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;

/*
 * General-purpose MCP error code constants.
 *
 * Introduced by the Events SEP (spec commit 567be29) as a consolidated set
 * intended for promotion to the base MCP error registry; they are not
 * events-specific. The structured `data` field disambiguates the resource
 * kind / limit / feature where helpful.
 */
/**
 * MCP error code: the addressed resource does not exist.
 * `data.kind` (e.g. `'event'`, `'subscription'`) names the missing resource.
 */
export const NOT_FOUND = -32_011;
/**
 * MCP error code: the caller is not permitted to perform this operation
 * (unauthenticated, or authenticated but lacking permission).
 */
export const FORBIDDEN = -32_012;
/**
 * MCP error code: a server-side limit was reached.
 * `data.limit` names the limit, `data.max` carries the configured ceiling.
 */
export const RESOURCE_EXHAUSTED = -32_013;
/**
 * MCP error code: the requested feature/value is not supported by this server.
 * `data.feature` / `data.value` describe what was rejected.
 */
export const UNSUPPORTED = -32_014;
/**
 * MCP error code: the supplied callback endpoint was rejected or unreachable.
 * `data.reason` carries a {@link WebhookLastError}-shaped category when known.
 */
export const CALLBACK_ENDPOINT_ERROR = -32_015;
