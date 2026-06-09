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
    /**
     * Legacy error code for reads of nonexistent resources.
     *
     * @deprecated Per SEP-2164, servers MUST return {@link ProtocolErrorCode.InvalidParams}
     * (`-32602`, with the requested URI in `data.uri`) for nonexistent resources. This code
     * remains exported because clients SHOULD still accept `-32002` from older servers.
     */
    ResourceNotFound = -32_002,
    /**
     * Processing the request requires a capability the client did not declare
     * in the request's `clientCapabilities` (protocol revision 2026-07-28).
     */
    MissingRequiredClientCapability = -32_003,
    /**
     * The request's protocol version is unknown to the server or unsupported
     * by it (protocol revision 2026-07-28).
     */
    UnsupportedProtocolVersion = -32_004,
    UrlElicitationRequired = -32_042
}
