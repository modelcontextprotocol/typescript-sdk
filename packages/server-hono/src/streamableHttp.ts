import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { getParsedBody } from '@modelcontextprotocol/server';
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
    return async (c: Context) => {
        let parsedBody = c.get('parsedBody');
        if (parsedBody === undefined && c.req.method === 'POST') {
            // Parse from a clone so we don't consume the original request stream.
            parsedBody = await getParsedBody(c.req.raw.clone());
        }
        const authInfo = c.get('auth');
        return transport.handleRequest(c.req.raw, { authInfo, parsedBody });
    };
}
