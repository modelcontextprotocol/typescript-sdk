import type { FetchLike } from '@modelcontextprotocol/core-internal';

import type { AuthRequestContext, OAuthClientProvider } from './auth';
import { adaptOAuthProvider, auth, extractWWWAuthenticateParams, UnauthorizedError } from './auth';
import type { DpopSession } from './dpop';
import { isDpopNonceChallenge } from './dpop';

/**
 * Middleware function that wraps and enhances fetch functionality.
 * Takes a fetch handler and returns an enhanced fetch handler.
 */
export type Middleware = (next: FetchLike) => FetchLike;

/**
 * Creates a fetch wrapper that handles OAuth authentication automatically.
 *
 * This wrapper will:
 * - Add `Authorization` headers with access tokens — `DPoP` scheme plus a per-request proof
 *   (RFC 9449 / SEP-1932) when {@linkcode OAuthClientProvider.dpop | provider.dpop()} resolves to
 *   a session, `Bearer` otherwise
 * - Handle 401 responses by attempting re-authentication
 * - Retry the original request after successful auth
 * - Handle OAuth errors appropriately ({@linkcode index.OAuthErrorCode.InvalidClient | OAuthErrorCode.InvalidClient}, etc.)
 *
 * The `baseUrl` parameter is optional and defaults to using the domain from the request URL.
 * However, you should explicitly provide `baseUrl` when:
 * - Making requests to multiple subdomains (e.g., api.example.com, cdn.example.com)
 * - Using API paths that differ from OAuth discovery paths (e.g., requesting /api/v1/data but OAuth is at /)
 * - The OAuth server is on a different domain than your API requests
 * - You want to ensure consistent OAuth behavior regardless of request URLs
 *
 * For MCP transports, set `baseUrl` to the same URL you pass to the transport constructor.
 *
 * Note: This wrapper is designed for general-purpose fetch operations.
 * MCP transports (SSE and StreamableHTTP) already have built-in OAuth handling
 * and should not need this wrapper.
 *
 * @param provider - OAuth client provider for authentication
 * @param baseUrl - Base URL for OAuth server discovery (defaults to request URL domain)
 * @returns A fetch middleware function
 */
export const withOAuth =
    (provider: OAuthClientProvider, baseUrl?: string | URL): Middleware =>
    next => {
        // Delegates request-signing to the exact same authorizeRequest/consumeChallenge logic
        // transports use, so a provider with a `dpop()` session gets identical DPoP behavior here.
        const authProvider = adaptOAuthProvider(provider);

        return async (input, init) => {
            const ctx: AuthRequestContext = {
                method: (init?.method ?? 'GET').toUpperCase(),
                url: new URL(input.toString())
            };

            const makeRequest = async (): Promise<Response> => {
                const headers = new Headers(init?.headers);

                const authHeaders = await authProvider.authorizeRequest?.(ctx);
                for (const [name, value] of Object.entries(authHeaders ?? {})) {
                    headers.set(name, value);
                }

                return await next(input, { ...init, headers });
            };

            let response = await makeRequest();

            // Two independent, single-shot retry budgets — a DPoP nonce retry and a credential
            // re-authorization — tried in *whichever order the server actually challenges them*.
            // Both orders are real: a not-yet-authenticated request gets the credential retry
            // first and only discovers the RS's nonce requirement once it presents a valid token
            // (auth/dpop-nonce's shape); a request that already holds a valid token but stale
            // nonce state gets the nonce retry first. Neither retry is spent more than once, so
            // this loop runs at most twice before falling through to the final 401 check below —
            // it cannot loop indefinitely even against a server that never stops challenging.
            let usedNonceRetry = false;
            let usedCredentialRetry = false;
            while (response.status === 401 && (!usedNonceRetry || !usedCredentialRetry)) {
                // RFC 9449 §9: a DPoP `use_dpop_nonce` challenge is not a credential failure — the
                // token and proof key are still valid, only the proof needs re-signing with the
                // nonce just captured. Handled before re-authorization below, which would
                // otherwise misdiagnose it as an expired/invalid token.
                if (!usedNonceRetry && (await authProvider.consumeChallenge?.(response, ctx))) {
                    usedNonceRetry = true;
                    response = await makeRequest();
                    continue;
                }
                if (usedCredentialRetry) break;
                usedCredentialRetry = true;
                try {
                    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);

                    // Use provided baseUrl or extract from request URL
                    const serverUrl = baseUrl || ctx.url.origin;

                    const result = await auth(provider, {
                        serverUrl,
                        resourceMetadataUrl,
                        scope,
                        fetchFn: next
                    });

                    if (result === 'REDIRECT') {
                        throw new UnauthorizedError('Authentication requires user authorization - redirect initiated');
                    }

                    if (result !== 'AUTHORIZED') {
                        throw new UnauthorizedError(`Authentication failed with result: ${result}`);
                    }

                    // Retry the request with fresh tokens
                    response = await makeRequest();
                } catch (error) {
                    if (error instanceof UnauthorizedError) {
                        throw error;
                    }
                    throw new UnauthorizedError(`Failed to re-authenticate: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            // If we still have a 401 after both retry budgets are spent, throw an error
            if (response.status === 401) {
                throw new UnauthorizedError(`Authentication failed for ${ctx.url}`);
            }

            return response;
        };
    };

/**
 * A function returning the current access token, or `undefined` if none is available yet. See
 * {@linkcode withDpop}.
 */
export type DpopTokenSource = () => string | undefined | Promise<string | undefined>;

/**
 * Creates a fetch wrapper that presents an access token using the `DPoP` Authorization scheme
 * (RFC 9449 / SEP-1932) instead of `Bearer`: every request carries `Authorization: DPoP <token>`
 * plus a fresh `DPoP` proof bound to that request's method and URL, and a resource-server
 * `use_dpop_nonce` challenge (RFC 9449 §9) is retried once, inline, with the server-supplied nonce.
 *
 * Use this when you already manage the access token yourself (a non-OAuth token source, or
 * credentials obtained out-of-band) and only need DPoP's request-signing behavior. For the full
 * OAuth flow with DPoP — discovery, token exchange, refresh, all DPoP-bound — implement
 * {@linkcode OAuthClientProvider.dpop} on your provider and pass it to {@linkcode withOAuth}
 * instead; that composes the same signing logic with token acquisition.
 *
 * @param session - The DPoP signing session (key pair + nonce state). Reuse the same session
 *   across requests to the same server so its nonce state persists.
 * @param getToken - Returns the current access token, or `undefined` if none is available yet
 *   (the request proceeds unauthenticated, matching {@linkcode withOAuth}'s no-token behavior).
 * @returns A fetch middleware function
 */
export const withDpop =
    (session: DpopSession, getToken: DpopTokenSource): Middleware =>
    next => {
        return async (input, init) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const url = new URL(input.toString());

            const makeRequest = async (): Promise<Response> => {
                const headers = new Headers(init?.headers);
                const accessToken = await getToken();
                if (accessToken) {
                    const proof = await session.buildProof({ htm: method, htu: url, accessToken });
                    headers.set('Authorization', `DPoP ${accessToken}`);
                    headers.set('DPoP', proof);
                }
                return await next(input, { ...init, headers });
            };

            let response = await makeRequest();

            // Only retry when the challenge carries a fresh DPoP-Nonce — otherwise the retry
            // would re-send the nonce the server just rejected.
            if (isDpopNonceChallenge(response) && response.headers.has('dpop-nonce')) {
                session.observeNonce(response, url);
                response = await makeRequest();
            }

            return response;
        };
    };

/**
 * Logger function type for HTTP requests
 */
export type RequestLogger = (input: {
    method: string;
    url: string | URL;
    status: number;
    statusText: string;
    duration: number;
    requestHeaders?: Headers;
    responseHeaders?: Headers;
    error?: Error;
}) => void;

/**
 * Configuration options for the logging middleware
 */
export type LoggingOptions = {
    /**
     * Custom logger function, defaults to console logging
     */
    logger?: RequestLogger;

    /**
     * Whether to include request headers in logs
     * @default false
     */
    includeRequestHeaders?: boolean;

    /**
     * Whether to include response headers in logs
     * @default false
     */
    includeResponseHeaders?: boolean;

    /**
     * Status level filter - only log requests with status >= this value
     * Set to `0` to log all requests, `400` to log only errors
     * @default 0
     */
    statusLevel?: number;
};

/**
 * Creates a fetch middleware that logs HTTP requests and responses.
 *
 * When called without arguments `withLogging()`, it uses the default logger that:
 * - Logs successful requests (2xx) to `console.log`
 * - Logs error responses (4xx/5xx) and network errors to `console.error`
 * - Logs all requests regardless of status (`statusLevel: 0`)
 * - Does not include request or response headers in logs
 * - Measures and displays request duration in milliseconds
 *
 * Important: the default logger uses both `console.log` and `console.error` so it should not be used with
 * `stdio` transports and applications.
 *
 * @param options - Logging configuration options
 * @returns A fetch middleware function
 */
export const withLogging = (options: LoggingOptions = {}): Middleware => {
    const { logger, includeRequestHeaders = false, includeResponseHeaders = false, statusLevel = 0 } = options;

    const defaultLogger: RequestLogger = input => {
        const { method, url, status, statusText, duration, requestHeaders, responseHeaders, error } = input;

        let message = error
            ? `HTTP ${method} ${url} failed: ${error.message} (${duration}ms)`
            : `HTTP ${method} ${url} ${status} ${statusText} (${duration}ms)`;

        // Add headers to message if requested
        if (includeRequestHeaders && requestHeaders) {
            const reqHeaders = [...requestHeaders.entries()].map(([key, value]) => `${key}: ${value}`).join(', ');
            message += `\n  Request Headers: {${reqHeaders}}`;
        }

        if (includeResponseHeaders && responseHeaders) {
            const resHeaders = [...responseHeaders.entries()].map(([key, value]) => `${key}: ${value}`).join(', ');
            message += `\n  Response Headers: {${resHeaders}}`;
        }

        if (error || status >= 400) {
            // eslint-disable-next-line no-console
            console.error(message);
        } else {
            // eslint-disable-next-line no-console
            console.log(message);
        }
    };

    const logFn = logger || defaultLogger;

    return next => async (input, init) => {
        const startTime = performance.now();
        const method = init?.method || 'GET';
        const url = typeof input === 'string' ? input : input.toString();
        const requestHeaders = includeRequestHeaders ? new Headers(init?.headers) : undefined;

        try {
            const response = await next(input, init);
            const duration = performance.now() - startTime;

            // Only log if status meets the log level threshold
            if (response.status >= statusLevel) {
                logFn({
                    method,
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    duration,
                    requestHeaders,
                    responseHeaders: includeResponseHeaders ? response.headers : undefined
                });
            }

            return response;
        } catch (error) {
            const duration = performance.now() - startTime;

            // Always log errors regardless of log level
            logFn({
                method,
                url,
                status: 0,
                statusText: 'Network Error',
                duration,
                requestHeaders,
                error: error as Error
            });

            throw error;
        }
    };
};

/**
 * Composes multiple fetch middleware functions into a single middleware pipeline.
 * Middleware are applied in the order they appear, creating a chain of handlers.
 *
 * @example
 * ```ts source="./middleware.examples.ts#applyMiddlewares_basicUsage"
 * // Create a middleware pipeline that handles both OAuth and logging
 * const enhancedFetch = applyMiddlewares(withOAuth(oauthProvider, 'https://api.example.com'), withLogging({ statusLevel: 400 }))(fetch);
 *
 * // Use the enhanced fetch - it will handle auth and log errors
 * const response = await enhancedFetch('https://api.example.com/data');
 * ```
 *
 * @param middleware - Array of fetch middleware to compose into a pipeline
 * @returns A single composed middleware function
 */
export const applyMiddlewares = (...middleware: Middleware[]): Middleware => {
    return next => {
        let handler = next;
        for (const mw of middleware) {
            handler = mw(handler);
        }
        return handler;
    };
};

/**
 * Helper function to create custom fetch middleware with cleaner syntax.
 * Provides the next handler and request details as separate parameters for easier access.
 *
 * @example
 * ```ts source="./middleware.examples.ts#createMiddleware_examples"
 * // Create custom authentication middleware
 * const customAuthMiddleware = createMiddleware(async (next, input, init) => {
 *     const headers = new Headers(init?.headers);
 *     headers.set('X-Custom-Auth', 'my-token');
 *
 *     const response = await next(input, { ...init, headers });
 *
 *     if (response.status === 401) {
 *         console.log('Authentication failed');
 *     }
 *
 *     return response;
 * });
 *
 * // Create conditional middleware
 * const conditionalMiddleware = createMiddleware(async (next, input, init) => {
 *     const url = typeof input === 'string' ? input : input.toString();
 *
 *     // Only add headers for API routes
 *     if (url.includes('/api/')) {
 *         const headers = new Headers(init?.headers);
 *         headers.set('X-API-Version', 'v2');
 *         return next(input, { ...init, headers });
 *     }
 *
 *     // Pass through for non-API routes
 *     return next(input, init);
 * });
 *
 * // Create caching middleware
 * const cacheMiddleware = createMiddleware(async (next, input, init) => {
 *     const cacheKey = typeof input === 'string' ? input : input.toString();
 *
 *     // Check cache first
 *     const cached = await getFromCache(cacheKey);
 *     if (cached) {
 *         return new Response(cached, { status: 200 });
 *     }
 *
 *     // Make request and cache result
 *     const response = await next(input, init);
 *     if (response.ok) {
 *         await saveToCache(cacheKey, await response.clone().text());
 *     }
 *
 *     return response;
 * });
 * ```
 *
 * @param handler - Function that receives the next handler and request parameters
 * @returns A fetch middleware function
 */
export const createMiddleware = (handler: (next: FetchLike, input: string | URL, init?: RequestInit) => Promise<Response>): Middleware => {
    return next => (input, init) => handler(next, input as string | URL, init);
};
