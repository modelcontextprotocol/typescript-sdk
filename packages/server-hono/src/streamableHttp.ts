import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { Context, Handler } from 'hono';

/**
 * Convenience Hono handler for the WebStandard Streamable HTTP transport.
 *
 * Usage:
 * ```ts
 * app.all('/mcp', mcpStreamableHttpHandler(transport))
 * ```
 */
export function mcpStreamableHttpHandler(transport: WebStandardStreamableHTTPServerTransport): Handler {
    return (c: Context) => transport.handleRequest(c.req.raw);
}
