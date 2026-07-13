// Moved: the protocol constants now live in @modelcontextprotocol/core (packages/core/src/constants.ts).
// This module re-exports them one-to-one so every existing import path keeps working.
//
// Add new constants in packages/core/src/constants.ts, never here — this file only forwards, and
// core-internal's schemaShims test enforces that it stays free of zod imports and definitions.
export {
    BAGGAGE_META_KEY,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    JSONRPC_VERSION,
    LATEST_PROTOCOL_VERSION,
    LOG_LEVEL_META_KEY,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    PROTOCOL_VERSION_META_KEY,
    RELATED_TASK_META_KEY,
    SUBSCRIPTION_ID_META_KEY,
    SUPPORTED_PROTOCOL_VERSIONS,
    TRACEPARENT_META_KEY,
    TRACESTATE_META_KEY
} from '@modelcontextprotocol/core/internal';
