export const SIMPLE_RENAMES: Record<string, string> = {
    McpError: 'ProtocolError',
    JSONRPCError: 'JSONRPCErrorResponse',
    JSONRPCErrorSchema: 'JSONRPCErrorResponseSchema',
    isJSONRPCError: 'isJSONRPCErrorResponse',
    isJSONRPCResponse: 'isJSONRPCResultResponse',
    // v1's JSONRPCResponse type / JSONRPCResponseSchema constant both validated only *result*
    // responses. v2 reuses each name for the result|error form — the type becomes
    // `Infer<z.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema])>` and the schema the
    // matching `z.union([...])` — so a migrated `JSONRPCResponseSchema.parse(...)` (or a typed
    // `JSONRPCResponse` value) would silently widen. Rename both to the result-only equivalents to
    // preserve v1 behavior — mirroring the isJSONRPCResponse guard rename above. Both the type and the
    // schema are public in v2 (re-exported from core via @modelcontextprotocol/client | /server).
    JSONRPCResponse: 'JSONRPCResultResponse',
    JSONRPCResponseSchema: 'JSONRPCResultResponseSchema',
    ResourceReference: 'ResourceTemplateReference',
    ResourceReferenceSchema: 'ResourceTemplateReferenceSchema',
    // Era-scoped rename — see docs/migration/upgrade-to-v2.md (Types & schemas).
    LATEST_PROTOCOL_VERSION: 'LATEST_LEGACY_PROTOCOL_VERSION',
    SUPPORTED_PROTOCOL_VERSIONS: 'SUPPORTED_LEGACY_PROTOCOL_VERSIONS'
};

export const ERROR_CODE_SDK_MEMBERS = new Set(['RequestTimeout', 'ConnectionClosed']);
