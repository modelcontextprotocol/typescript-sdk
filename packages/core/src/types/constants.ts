export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';

/* SEP-2575 per-request _meta scope keys (stateless servers read these instead of initialize state) */
export const META_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const META_LOG_LEVEL_KEY = 'io.modelcontextprotocol/logLevel';

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
