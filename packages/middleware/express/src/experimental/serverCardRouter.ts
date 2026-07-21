import type { AICatalogResponseOptions, ServerCardResponseOptions } from '@modelcontextprotocol/server/experimental/server-card';
import { aiCatalogResponse, serverCardResponse } from '@modelcontextprotocol/server/experimental/server-card';
import type { Request as ExpressRequest, Response as ExpressResponse, Router } from 'express';
import express from 'express';

/**
 * Options for {@link mcpServerCardRouter}: the runtime-neutral
 * `ServerCardResponseOptions` from
 * `@modelcontextprotocol/server/experimental/server-card`, plus an optional
 * `catalog` to also serve the AI Catalog from this app.
 */
export interface McpServerCardRouterOptions extends ServerCardResponseOptions {
    /**
     * Also serve an AI Catalog (at `/.well-known/ai-catalog.json` unless the
     * options name another path). Best practice is to publish the catalog on
     * the domain users associate with the service.
     */
    catalog?: AICatalogResponseOptions;
}

/**
 * Builds an Express router that serves a Server Card at the reserved
 * `<mcp-path>/server-card` route, and optionally an AI Catalog at its
 * well-known path. Thin adapter over the runtime-neutral responders from
 * `@modelcontextprotocol/server/experimental/server-card`; behavior
 * (CORS, Cache-Control, ETag/304, 405, preflight) is identical.
 *
 * Mount at the application root:
 *
 * ```ts
 * app.use(mcpServerCardRouter({ card, mcpUrl, catalog: { catalog } }));
 * app.all('/mcp', mcpHandler);
 * ```
 *
 * An exact `/mcp` mount never sees `GET /mcp/server-card`; this router is
 * what serves it.
 *
 * Experimental: tracks the `experimental-ext-server-card` spec repository and
 * may change or be removed in any release.
 */
export function mcpServerCardRouter(options: McpServerCardRouterOptions): Router {
    const { catalog, ...cardOptions } = options;
    const router = express.Router();
    router.use((req, res, next) => {
        const request = toFetchRequest(req);
        const matched =
            serverCardResponse(request, cardOptions) ?? (catalog === undefined ? undefined : aiCatalogResponse(request, catalog));
        if (matched === undefined) {
            next();
            return;
        }
        matched.then(response => writeFetchResponse(response, res)).catch((error: unknown) => next(error));
    });
    return router;
}

function toFetchRequest(req: ExpressRequest): Request {
    const url = new URL(req.originalUrl, `${req.protocol}://${req.headers.host ?? 'localhost'}`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
            headers.set(name, value);
        } else if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        }
    }
    // The responders only ever read GET/HEAD/OPTIONS (and answer 405 for the
    // rest), so the converted request never needs a body.
    return new Request(url, { method: req.method, headers });
}

async function writeFetchResponse(response: Response, res: ExpressResponse): Promise<void> {
    res.status(response.status);
    for (const [name, value] of response.headers.entries()) {
        res.setHeader(name, value);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > 0) {
        res.send(body);
    } else {
        res.end();
    }
}
