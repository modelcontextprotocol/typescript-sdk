// v1 compat: `@modelcontextprotocol/sdk/server/sse.js`
// The SSE server transport was removed in v2. Use Streamable HTTP instead.

/**
 * @deprecated SSE server transport was removed in v2. Use {@link NodeStreamableHTTPServerTransport}
 * (from `@modelcontextprotocol/node`) instead. This alias is provided for source-compat only;
 * the wire behavior is Streamable HTTP, not legacy SSE.
 */
export { NodeStreamableHTTPServerTransport as SSEServerTransport } from '@modelcontextprotocol/node';
