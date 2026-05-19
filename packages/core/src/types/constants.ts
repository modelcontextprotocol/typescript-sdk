export const DRAFT_PROTOCOL_VERSION = 'DRAFT-2026-v1';
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = '2025-03-26';
// DRAFT at the end so `[0]` (the default-preferred version sent by Client and
// returned by Server fallback) stays the latest released version. The 2026
// path is opted into via `server/discover` auto-probe, not version preference.
export const SUPPORTED_PROTOCOL_VERSIONS = [
    LATEST_PROTOCOL_VERSION,
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07',
    DRAFT_PROTOCOL_VERSION
];

/* JSON-RPC types */
export const JSONRPC_VERSION = '2.0';

/* Standard JSON-RPC error code constants */
export const PARSE_ERROR = -32_700;
export const INVALID_REQUEST = -32_600;
export const METHOD_NOT_FOUND = -32_601;
export const INVALID_PARAMS = -32_602;
export const INTERNAL_ERROR = -32_603;
