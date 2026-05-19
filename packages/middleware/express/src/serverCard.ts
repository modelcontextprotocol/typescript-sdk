import type { ServerCard } from '@modelcontextprotocol/server';
import { parseServerCard, SERVER_CARD_WELL_KNOWN_PATH } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Router } from 'express';
import express from 'express';

import { allowedMethods } from './auth/metadataRouter.js';

/**
 * Options for {@link mcpServerCardRouter}.
 *
 * @experimental
 */
export interface ServerCardRouterOptions {
    /**
     * Path the card is served at, relative to where the router is mounted.
     *
     * @default '/.well-known/mcp-server-card'
     */
    path?: string;
}

/**
 * Builds an Express router that serves an MCP Server Card (SEP-2127) at
 * `/.well-known/mcp-server-card`.
 *
 * The card is validated against the Server Card schema when the router is
 * built, so a malformed card throws at startup rather than serving an invalid
 * document. The route is CORS-enabled (so browser-based MCP clients on any
 * origin can read it) and restricted to `GET`/`OPTIONS`.
 *
 * Mount it at the application root, alongside your `/mcp` route:
 *
 * ```ts
 * import express from 'express';
 * import { mcpServerCardRouter } from '@modelcontextprotocol/express';
 *
 * const app = express();
 * app.use(mcpServerCardRouter({
 *   $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
 *   name: 'example-org/weather',
 *   version: '1.0.0',
 *   description: 'Weather forecasts and alerts.',
 *   remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }]
 * }));
 * ```
 *
 * @throws {Error} if `card` fails Server Card schema validation.
 * @experimental
 */
export function mcpServerCardRouter(card: ServerCard, options?: ServerCardRouterOptions): Router {
    const body = JSON.stringify(parseServerCard(card));
    const path = options?.path ?? SERVER_CARD_WELL_KNOWN_PATH;

    const router = express.Router();
    // Server Cards must be fetchable from web-based MCP clients on any origin.
    router.use(path, cors(), allowedMethods(['GET', 'OPTIONS']));
    router.get(path, (_req, res) => {
        res.type('application/json').send(body);
    });
    return router;
}
