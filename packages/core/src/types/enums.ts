/**
 * Error codes for protocol errors that cross the wire as JSON-RPC error responses.
 * These follow the JSON-RPC specification and MCP-specific extensions.
 */
export enum ProtocolErrorCode {
    // Standard JSON-RPC error codes
    ParseError = -32_700,
    InvalidRequest = -32_600,
    MethodNotFound = -32_601,
    InvalidParams = -32_602,
    InternalError = -32_603,

    // MCP-specific error codes
    ResourceNotFound = -32_002,
    UrlElicitationRequired = -32_042,

    // Events-specific error codes
    EventNotFound = -32_011,
    EventUnauthorized = -32_012,
    TooManySubscriptions = -32_013,
    CursorExpired = -32_014,
    InvalidCallbackUrl = -32_015,
    SubscriptionNotFound = -32_016
}
