import { auth, extractResourceMetadataUrl, OAuthClientProvider, UnauthorizedError } from "../client/auth.js";
import { FetchLike } from "./transport.js";

export type FetchWrapper = (fetch: FetchLike) => FetchLike;

/**
 * Creates a fetch wrapper that handles OAuth authentication automatically.
 *
 * This wrapper will:
 * - Add Authorization headers with access tokens
 * - Handle 401 responses by attempting re-authentication
 * - Retry the original request after successful auth
 * - Handle OAuth errors appropriately (InvalidClientError, etc.)
 *
 * The baseUrl parameter is optional and defaults to using the domain from the request URL.
 * However, you should explicitly provide baseUrl when:
 * - Making requests to multiple subdomains (e.g., api.example.com, cdn.example.com)
 * - Using API paths that differ from OAuth discovery paths (e.g., requesting /api/v1/data but OAuth is at /)
 * - The OAuth server is on a different domain than your API requests
 * - You want to ensure consistent OAuth behavior regardless of request URLs
 *
 * For MCP transports, set baseUrl to the same URL you pass to the transport constructor.
 *
 * Note: This wrapper is designed for general-purpose fetch operations.
 * MCP transports (SSE and StreamableHTTP) already have built-in OAuth handling
 * and should not need this wrapper.
 *
 * @param provider - OAuth client provider for authentication
 * @param baseUrl - Base URL for OAuth server discovery (defaults to request URL domain)
 * @returns A fetch wrapper function
 */
export const withOAuth = (
  provider: OAuthClientProvider,
  baseUrl?: string | URL
): FetchWrapper =>
  (fetch) => {
    return async (input, init) => {
      const makeRequest = async (): Promise<Response> => {
        const headers = new Headers(init?.headers);

        // Add authorization header if tokens are available
        const tokens = await provider.tokens();
        if (tokens) {
          headers.set('Authorization', `Bearer ${tokens.access_token}`);
        }

        return await fetch(input, { ...init, headers });
      };

      let response = await makeRequest();

      // Handle 401 responses by attempting re-authentication
      if (response.status === 401) {
        try {
          const resourceMetadataUrl = extractResourceMetadataUrl(response);

          // Use provided baseUrl or extract from request URL
          const serverUrl = baseUrl || (typeof input === 'string' ? new URL(input).origin : input.origin);

          const result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            fetchFn: fetch
          });

          if (result === "REDIRECT") {
            throw new UnauthorizedError("Authentication requires user authorization - redirect initiated");
          }

          if (result !== "AUTHORIZED") {
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
 * Logger function type for HTTP requests
 */
export type RequestLogger = (
  input: {
    method: string,
    url: string | URL,
    status: number,
    statusText: string,
    duration: number,
    requestHeaders?: Headers,
    responseHeaders?: Headers,
    error?: Error
  }
) => void;

/**
 * Configuration options for the logging wrapper
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
   * Set to 0 to log all requests, 400 to log only errors
   * @default 0
   */
  statusLevel?: number;
};

/**
 * Creates a fetch wrapper that logs HTTP requests and responses.
 *
 * When called without arguments `withLogging()`, it uses the default logger that:
 * - Logs successful requests (2xx) to console.log
 * - Logs error responses (4xx/5xx) and network errors to console.error
 * - Logs all requests regardless of status (statusLevel: 0)
 * - Does not include request or response headers in logs
 * - Measures and displays request duration in milliseconds
 *
 * @param options - Logging configuration options
 * @returns A fetch wrapper function
 */
export const withLogging = (options: LoggingOptions = {}): FetchWrapper => {
  const {
    logger,
    includeRequestHeaders = false,
    includeResponseHeaders = false,
    statusLevel = 0
  } = options;

  const defaultLogger: RequestLogger = (input) => {
    const { method, url, status, statusText, duration, requestHeaders, responseHeaders, error } = input;

    let message = error
      ? `HTTP ${method} ${url} failed: ${error.message} (${duration}ms)`
      : `HTTP ${method} ${url} ${status} ${statusText} (${duration}ms)`;

    // Add headers to message if requested
    if (includeRequestHeaders && requestHeaders) {
      const reqHeaders = Array.from(requestHeaders.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      message += `\n  Request Headers: {${reqHeaders}}`;
    }

    if (includeResponseHeaders && responseHeaders) {
      const resHeaders = Array.from(responseHeaders.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      message += `\n  Response Headers: {${resHeaders}}`;
    }

    if (error || status >= 400) {
      console.error(message);
    } else {
      console.log(message);
    }
  };

  const logFn = logger || defaultLogger;

  return (fetch) => async (input, init) => {
    const startTime = performance.now();
    const method = init?.method || 'GET';
    const url = typeof input === 'string' ? input : input.toString();
    const requestHeaders = includeRequestHeaders ? new Headers(init?.headers) : undefined;

    try {
      const response = await fetch(input, init);
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
 * Utility function to compose multiple fetch wrappers into a single wrapper.
 * Wrappers are applied in the order they appear in the array.
 *
 * @example
 * ```typescript
 * // Create a fetch wrapper that handles both OAuth and logging
 * const wrappedFetch = withWrappers(
 *   withOAuth(oauthProvider, 'https://api.example.com'),
 *   withLogging({ statusLevel: 400 })
 * )(fetch);
 *
 * // Use the wrapped fetch - it will handle auth and log errors
 * const response = await wrappedFetch('https://api.example.com/data');
 * ```
 *
 * @param wrappers - Array of fetch wrappers to compose
 * @returns A single composed fetch wrapper
 */
export const withWrappers = (...wrappers: FetchWrapper[]): FetchWrapper => {
  return (fetch) => {
    return wrappers.reduce((wrappedFetch, wrapper) => wrapper(wrappedFetch), fetch);
  };
};
