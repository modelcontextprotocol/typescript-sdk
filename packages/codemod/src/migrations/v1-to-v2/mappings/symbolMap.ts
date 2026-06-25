export const SIMPLE_RENAMES: Record<string, string> = {
    McpError: 'ProtocolError',
    JSONRPCError: 'JSONRPCErrorResponse',
    JSONRPCErrorSchema: 'JSONRPCErrorResponseSchema',
    isJSONRPCError: 'isJSONRPCErrorResponse',
    isJSONRPCResponse: 'isJSONRPCResultResponse',
    // v1's JSONRPCResponseSchema validated only *result* responses. v2 reuses the name for a
    // z.union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]) that also accepts error
    // responses, so a migrated `JSONRPCResponseSchema.parse(...)` would silently widen. Rename to the
    // result-only schema to preserve v1 behavior — mirroring the isJSONRPCResponse guard rename above.
    // (The TYPE JSONRPCResponse/JSONRPCResultResponse is not part of the public v2 surface, so only the
    // schema constant — re-exported by core — is renamed here.)
    JSONRPCResponseSchema: 'JSONRPCResultResponseSchema',
    ResourceReference: 'ResourceTemplateReference',
    ResourceReferenceSchema: 'ResourceTemplateReferenceSchema'
};

export const ERROR_CODE_SDK_MEMBERS = new Set(['RequestTimeout', 'ConnectionClosed']);
