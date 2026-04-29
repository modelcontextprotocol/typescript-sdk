export const SIMPLE_RENAMES: Record<string, string> = {
    McpError: 'ProtocolError',
    JSONRPCError: 'JSONRPCErrorResponse',
    JSONRPCErrorSchema: 'JSONRPCErrorResponseSchema',
    isJSONRPCError: 'isJSONRPCErrorResponse',
    isJSONRPCResponse: 'isJSONRPCResultResponse',
    ResourceReference: 'ResourceTemplateReference',
    ResourceReferenceSchema: 'ResourceTemplateReferenceSchema'
};

export const ERROR_CODE_SDK_MEMBERS = new Set(['RequestTimeout', 'ConnectionClosed']);
