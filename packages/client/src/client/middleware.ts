import type { FetchLike } from '@modelcontextprotocol/core-internal';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- AuthProvider referenced in JSDoc {@linkcode}
import type { AuthProvider, OAuthClientProvider } from './auth';
import { auth, extractWWWAuthenticateParams, UnauthorizedError } from './auth';
import { markAuthSeamEscape } from './authSeam';
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
 * - Add `Authorization` headers with access tokens
 * - Handle 401 responses by attempting re-authentication
 * - Retry the original request after successful auth
 * - Handle OAuth errors appropriately ({@linkcode index.OAuthErrorCode.InvalidClient | OAuthErrorCode.InvalidClient}, etc.)
 * - When {@linkcode OAuthClientProvider.dpop | provider.dpop()} is implemented, present DPoP-bound
 *   tokens with the `DPoP` scheme plus a per-request proof (RFC 9449 / SEP-1932) by composing
 *   {@linkcode withDpopFromProvider} underneath — so a `use_dpop_nonce` challenge is retried
 *   inline on every attempt, independently of the single re-authentication retry here
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
    baseNext => {
        // DPoP request-signing (and its nonce retry) sits *below* the Bearer/re-auth layer so it
        // sees the final method/URL of every attempt and every response. `auth()` keeps the
        // unwrapped fetch: token-endpoint DPoP is handled inside executeTokenRequest.
        const next = provider.dpop ? withDpopFromProvider(provider)(baseNext) : baseNext;

        return async (input, init) => {
            const makeRequest = async (): Promise<Response> => {
                const headers = new Headers(init?.headers);

                // Add authorization header if tokens are available
                const tokens = await provider.tokens();
                if (tokens) {
                    headers.set('Authorization', `Bearer ${tokens.access_token}`);
                }

                return await next(input, { ...init, headers });
            };

            let response = await makeRequest();

            // Handle 401 responses by attempting re-authentication
            if (response.status === 401) {
                try {
                    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);

                    // Use provided baseUrl or extract from request URL
                    const serverUrl = baseUrl || (typeof input === 'string' ? new URL(input).origin : input.origin);

                    const result = await auth(provider, {
                        serverUrl,
                        resourceMetadataUrl,
                        scope,
                        fetchFn: baseNext
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

            // If we still have a 401 after re-auth attempt, throw an error
            if (response.status === 401) {
                const url = typeof input === 'string' ? input : input.toString();
                throw new UnauthorizedError(`Authentication failed for ${url}`);
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
 * A {@linkcode DpopSession}, or a function resolving to one (or to `undefined` to leave the request
 * untouched). The function form lets the session be created lazily or come from
 * {@linkcode OAuthClientProvider.dpop}. See {@linkcode withDpop}.
 */
export type DpopSessionSource = DpopSession | (() => DpopSession | undefined | Promise<DpopSession | undefined>);

/**
 * Creates a fetch wrapper that presents an access token using the `DPoP` Authorization scheme
 * (RFC 9449 / SEP-1932) instead of `Bearer`: every request carries `Authorization: DPoP <token>`
 * plus a fresh `DPoP` proof bound to that request's method and URL, a resource-server
 * `use_dpop_nonce` challenge (RFC 9449 §9) is retried once, inline, with the server-supplied nonce,
 * and a `DPoP-Nonce` delivered on any response is remembered for the next proof (RFC 9449 §8.2).
 *
 * Because it wraps `fetch` itself, the proof is always bound to the request actually sent and every
 * response is observed — which is why the MCP transports apply this wrapper internally (via
 * {@linkcode withDpopFromProvider}) when their `authProvider` implements
 * {@linkcode OAuthClientProvider.dpop | dpop()}, rather than threading request context through
 * {@linkcode AuthProvider}.
 *
 * Use this directly when you already manage the access token yourself (a non-OAuth token source,
 * or credentials obtained out-of-band) and only need DPoP's request-signing behavior — e.g.
 * `fetch: withDpop(session, getToken)(fetch)` alongside a minimal `authProvider: { token }`.
 *
 * @param session - The DPoP signing session (key pair + nonce state), or a function resolving to
 *   it. Reuse the same session across requests to the same server so its nonce state persists.
 *   When the function resolves to `undefined` the request passes through unchanged.
 * @param getToken - Returns the current access token, or `undefined` if none is available (the
 *   request passes through unchanged — any `Authorization` header already on it is left as is).
 * @returns A fetch middleware function
 */
export const withDpop =
    (session: DpopSessionSource, getToken: DpopTokenSource): Middleware =>
    next => {
        const resolveSession = typeof session === 'function' ? session : () => session;

        return async (input, init) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const url = new URL(input.toString());
            const activeSession = await resolveSession();
            if (!activeSession) return next(input, init);

            const makeRequest = async (): Promise<Response> => {
                const accessToken = await getToken();
                if (!accessToken) return next(input, init);
                const headers = new Headers(init?.headers);
                const proof = await activeSession.buildProof({ htm: method, htu: url, accessToken });
                headers.set('Authorization', `DPoP ${accessToken}`);
                headers.set('DPoP', proof);
                return next(input, { ...init, headers });
            };

            let response = await makeRequest();

            // Only retry when the challenge carries a fresh DPoP-Nonce — otherwise the retry
            // would re-send the nonce the server just rejected. RFC 9449 §4.2: the retry gets a
            // freshly signed proof (new jti); the original is never replayed.
            if (isDpopNonceChallenge(response) && response.headers.has('dpop-nonce')) {
                activeSession.observeNonce(response, url);
                await response.text?.().catch(() => {});
                response = await makeRequest();
            }
            // RFC 9449 §8.2: a fresh nonce may ride on any response, success included.
            activeSession.observeNonce(response, url);

            return response;
        };
    };

/**
 * {@linkcode withDpop} driven by an {@linkcode OAuthClientProvider}: the session comes from
 * {@linkcode OAuthClientProvider.dpop | provider.dpop()} and the token from
 * {@linkcode OAuthClientProvider.tokens | provider.tokens()} — presented with the DPoP scheme only
 * when the AS actually issued `token_type: "DPoP"` (RFC 9449 §7.1); a Bearer token passes through
 * untouched.
 *
 * This is what the MCP transports and {@linkcode withOAuth} compose internally when the provider
 * implements `dpop()`. Use it directly only when building your own fetch pipeline around an
 * `OAuthClientProvider` (e.g. a custom re-authorization middleware) — place it *innermost*, below
 * whatever sets `Authorization: Bearer` and handles 401 re-authentication.
 */
export const withDpopFromProvider = (provider: OAuthClientProvider): Middleware =>
    withDpop(
        async () => {
            try {
                return await provider.dpop?.();
            } catch (error) {
                throw markAuthSeamEscape(error);
            }
        },
        async () => {
            let tokens;
            try {
                tokens = await provider.tokens();
            } catch (error) {
                throw markAuthSeamEscape(error);
            }
            return tokens?.token_type?.toLowerCase() === 'dpop' ? tokens.access_token : undefined;
        }
    );

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
