export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/* Reserved `_meta` keys for the per-request envelope (protocol revision 2026-07-28) */

/**
 * `_meta` key carrying the MCP protocol version governing a request.
 *
 * For the HTTP transport, the value must match the `MCP-Protocol-Version` header.
 */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

/**
 * `_meta` key identifying the client software making a request.
 */
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

/**
 * `_meta` key carrying the client's capabilities for a request.
 *
 * Capabilities are declared per request rather than once at initialization;
 * servers must not infer capabilities from prior requests.
 */
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

/**
 * `_meta` key carrying the desired log level for a request.
 *
 * When absent, the server must not send `notifications/message` notifications
 * for the request.
 *
 * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
 * in the specification for at least twelve months.
 */
export const LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
