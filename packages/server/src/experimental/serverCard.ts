/**
 * Server-side helpers for publishing an MCP Server Card (SEP-2127).
 *
 * A Server Card is a static discovery document served at
 * `/.well-known/mcp-server-card`. {@link createServerCardHandler} validates a
 * card once, then returns a tiny runtime-neutral request handler that answers
 * the well-known route — usable with any framework that speaks the Web
 * `Request`/`Response` API (Cloudflare Workers, Bun, Deno, Hono, Node 18+).
 *
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-server-card
 * @experimental
 * @module
 */

import type { ServerCard } from '@modelcontextprotocol/core';
import { parseServerCard, SERVER_CARD_WELL_KNOWN_PATH } from '@modelcontextprotocol/core';

/**
 * Options for {@link createServerCardHandler}.
 *
 * @experimental
 */
export interface ServerCardHandlerOptions {
    /**
     * Path the card is served at, matched against the request URL's pathname.
     *
     * @default '/.well-known/mcp-server-card'
     */
    path?: string;

    /**
     * Whether to add permissive CORS headers (`Access-Control-Allow-Origin: *`)
     * so browser-based MCP clients on any origin can fetch the card. When
     * enabled, `OPTIONS` preflight requests on the card path are answered too.
     *
     * @default true
     */
    cors?: boolean;
}

const ALLOWED_METHODS = 'GET, OPTIONS';

/**
 * Validates a {@link ServerCard} and returns a request handler that serves it
 * at the well-known Server Card path.
 *
 * The card is validated against the Server Card schema eagerly — if it is
 * malformed, this function throws synchronously so the bug surfaces at startup
 * rather than on the first request.
 *
 * The returned handler is path-aware: it returns a `Response` for requests
 * targeting the card path and `undefined` for everything else, so it composes
 * cleanly with an existing router.
 *
 * @throws {Error} if `card` fails Server Card schema validation.
 *
 * @example
 * ```ts
 * import { createServerCardHandler } from '@modelcontextprotocol/server';
 *
 * const serveCard = createServerCardHandler({
 *   $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
 *   name: 'example-org/weather',
 *   version: '1.0.0',
 *   description: 'Weather forecasts and alerts.',
 *   remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]
 * });
 *
 * // In your fetch handler:
 * export default {
 *   fetch(request: Request) {
 *     return serveCard(request) ?? handleMcp(request);
 *   }
 * };
 * ```
 *
 * @experimental
 */
export function createServerCardHandler(card: ServerCard, options?: ServerCardHandlerOptions): (request: Request) => Response | undefined {
    const body = JSON.stringify(parseServerCard(card));
    const path = options?.path ?? SERVER_CARD_WELL_KNOWN_PATH;
    const cors = options?.cors ?? true;

    // Response header sets are fully determined by `cors`, so build them once.
    const corsHeader: Record<string, string> = cors ? { 'Access-Control-Allow-Origin': '*' } : {};
    const okHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...corsHeader };
    const preflightHeaders: Record<string, string> = {
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': '*',
        ...corsHeader
    };
    const notAllowedHeaders: Record<string, string> = { Allow: ALLOWED_METHODS, ...corsHeader };

    return (request: Request): Response | undefined => {
        let pathname: string;
        try {
            pathname = new URL(request.url).pathname;
        } catch {
            return undefined;
        }
        if (pathname !== path) {
            return undefined;
        }

        if (request.method === 'OPTIONS' && cors) {
            return new Response(null, { status: 204, headers: preflightHeaders });
        }
        if (request.method !== 'GET') {
            return new Response(null, { status: 405, headers: notAllowedHeaders });
        }
        return new Response(body, { status: 200, headers: okHeaders });
    };
}
