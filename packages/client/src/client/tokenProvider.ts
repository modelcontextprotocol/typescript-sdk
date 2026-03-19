/**
 * Minimal interface for providing bearer tokens to MCP transports.
 *
 * Unlike `OAuthClientProvider` which assumes interactive browser-redirect OAuth,
 * `TokenProvider` is a simple function that returns a token string.
 * Use this for upfront auth, gateway/proxy patterns, service accounts,
 * or any scenario where tokens are managed externally.
 *
 * The provider is called before every request. If the server responds with 401,
 * the transport throws `UnauthorizedError` without retrying — the provider is
 * assumed to have already returned its freshest token. Catch `UnauthorizedError`
 * to invalidate any external cache and reconnect.
 *
 * @example
 * ```typescript
 * // Static token
 * const provider: TokenProvider = async () => "my-api-token";
 *
 * // Token from secure storage with refresh
 * const provider: TokenProvider = async () => {
 *   const token = await storage.getToken();
 *   if (isExpiringSoon(token)) {
 *     return (await refreshToken(token)).accessToken;
 *   }
 *   return token.accessToken;
 * };
 * ```
 */
export type TokenProvider = () => Promise<string | undefined>;

/**
 * Wraps a fetch function to automatically inject Bearer authentication headers.
 *
 * @example
 * ```typescript
 * const authedFetch = withBearerAuth(async () => getStoredToken());
 * const transport = new StreamableHTTPClientTransport(url, { fetch: authedFetch });
 * ```
 */
export function withBearerAuth(
    getToken: TokenProvider,
    fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response> = globalThis.fetch
): (url: string | URL, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
        const token = await getToken();
        if (token) {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${token}`);
            return fetchFn(url, { ...init, headers });
        }
        return fetchFn(url, init);
    };
}
