import type { AuthMetadataOptions, AuthRoute, AuthRouterOptions } from '@modelcontextprotocol/server';
import {
    getParsedBody,
    mcpAuthMetadataRouter as createWebAuthMetadataRouter,
    mcpAuthRouter as createWebAuthRouter
} from '@modelcontextprotocol/server';
import type { Handler } from 'hono';
import { Hono } from 'hono';

/**
 * Hono router adapter for the Web-standard `mcpAuthRouter` from `@modelcontextprotocol/server`.
 *
 * IMPORTANT: This router MUST be mounted at the application root.
 *
 * @example
 * ```ts
 * app.route('/', mcpAuthRouter(...))
 * ```
 */
export function mcpAuthRouter(options: AuthRouterOptions): Hono {
    const web = createWebAuthRouter(options);
    const router = new Hono();
    registerRoutes(router, web.routes);
    return router;
}

/**
 * Hono router adapter for the Web-standard `mcpAuthMetadataRouter` from `@modelcontextprotocol/server`.
 *
 * IMPORTANT: This router MUST be mounted at the application root.
 */
export function mcpAuthMetadataRouter(options: AuthMetadataOptions): Hono {
    const web = createWebAuthMetadataRouter(options);
    const router = new Hono();
    registerRoutes(router, web.routes);
    return router;
}

function registerRoutes(app: Hono, routes: AuthRoute[]): void {
    for (const route of routes) {
        // Use `all()` so unsupported methods still reach the handler and can return 405,
        // matching the Express adapter behavior.
        const handler: Handler = async c => {
            let parsedBody = c.get('parsedBody');
            if (parsedBody === undefined && c.req.method === 'POST') {
                // Parse from a clone so we don't consume the original request stream.
                parsedBody = await getParsedBody(c.req.raw.clone());
            }
            return route.handler(c.req.raw, { parsedBody });
        };
        app.all(route.path, handler);
    }
}

export function registerMcpAuthRoutes(app: Hono, options: AuthRouterOptions): void {
    app.route('/', mcpAuthRouter(options));
}

export function registerMcpAuthMetadataRoutes(app: Hono, options: AuthMetadataOptions): void {
    app.route('/', mcpAuthMetadataRouter(options));
}
