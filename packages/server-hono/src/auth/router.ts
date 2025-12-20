import type { AuthMetadataOptions, AuthRoute, AuthRouterOptions } from '@modelcontextprotocol/server';
import { mcpAuthMetadataRouter as createWebAuthMetadataRouter, mcpAuthRouter as createWebAuthRouter } from '@modelcontextprotocol/server';
import type { Handler, Hono } from 'hono';

export type RegisterMcpAuthRoutesOptions = AuthRouterOptions;

/**
 * Registers the standard MCP OAuth endpoints on a Hono app.
 *
 * IMPORTANT: These routes MUST be mounted at the application root.
 */
export function registerMcpAuthRoutes(app: Hono, options: RegisterMcpAuthRoutesOptions): void {
    const web = createWebAuthRouter(options);
    registerRoutes(app, web.routes);
}

/**
 * Registers only the auth metadata endpoints (RFC 8414 + RFC 9728) on a Hono app.
 *
 * IMPORTANT: These routes MUST be mounted at the application root.
 */
export function registerMcpAuthMetadataRoutes(app: Hono, options: AuthMetadataOptions): void {
    const web = createWebAuthMetadataRouter(options);
    registerRoutes(app, web.routes);
}

function registerRoutes(app: Hono, routes: AuthRoute[]): void {
    for (const route of routes) {
        // Hono's `on()` expects methods like 'GET', 'POST', etc.
        const handler: Handler = c => route.handler(c.req.raw);
        app.on(route.methods, route.path, handler);
    }
}
