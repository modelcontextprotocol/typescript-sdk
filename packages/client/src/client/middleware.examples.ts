/**
 * Type-checked examples for `middleware.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { Middleware } from './middleware.js';
import { applyMiddlewares, createMiddleware } from './middleware.js';

// Stubs for hypothetical application middleware
declare function withOAuth(provider: unknown, url: string): Middleware;
declare function withLogging(opts: { statusLevel: number }): Middleware;

// Stubs for hypothetical application cache
declare function getFromCache(key: string): Promise<string | undefined>;
declare function saveToCache(key: string, value: string): Promise<void>;

/**
 * Example: Creating a middleware pipeline for OAuth and logging.
 */
async function applyMiddlewares_basicUsage(oauthProvider: unknown) {
    //#region applyMiddlewares_basicUsage
    // Create a middleware pipeline that handles both OAuth and logging
    const enhancedFetch = applyMiddlewares(withOAuth(oauthProvider, 'https://api.example.com'), withLogging({ statusLevel: 400 }))(fetch);

    // Use the enhanced fetch - it will handle auth and log errors
    const response = await enhancedFetch('https://api.example.com/data');
    //#endregion applyMiddlewares_basicUsage
    return response;
}

/**
 * Example: Creating various custom middlewares with createMiddleware.
 */
function createMiddleware_examples() {
    //#region createMiddleware_examples
    // Create custom authentication middleware
    const customAuthMiddleware = createMiddleware(async (next, input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('X-Custom-Auth', 'my-token');

        const response = await next(input, { ...init, headers });

        if (response.status === 401) {
            console.log('Authentication failed');
        }

        return response;
    });

    // Create conditional middleware
    const conditionalMiddleware = createMiddleware(async (next, input, init) => {
        const url = typeof input === 'string' ? input : input.toString();

        // Only add headers for API routes
        if (url.includes('/api/')) {
            const headers = new Headers(init?.headers);
            headers.set('X-API-Version', 'v2');
            return next(input, { ...init, headers });
        }

        // Pass through for non-API routes
        return next(input, init);
    });

    // Create caching middleware
    const cacheMiddleware = createMiddleware(async (next, input, init) => {
        const cacheKey = typeof input === 'string' ? input : input.toString();

        // Check cache first
        const cached = await getFromCache(cacheKey);
        if (cached) {
            return new Response(cached, { status: 200 });
        }

        // Make request and cache result
        const response = await next(input, init);
        if (response.ok) {
            await saveToCache(cacheKey, await response.clone().text());
        }

        return response;
    });
    //#endregion createMiddleware_examples
    return { customAuthMiddleware, conditionalMiddleware, cacheMiddleware };
}
