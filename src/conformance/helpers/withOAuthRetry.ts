import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError
} from '@modelcontextprotocol/client';
import type { FetchLike, Middleware } from '@modelcontextprotocol/client';
import { ConformanceOAuthProvider } from './ConformanceOAuthProvider.js';

export const handle401 = async (
  response: Response,
  provider: ConformanceOAuthProvider,
  next: FetchLike,
  serverUrl: string | URL
): Promise<void> => {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  let result = await auth(provider, {
    serverUrl,
    resourceMetadataUrl,
    scope,
    fetchFn: next
  });

  if (result === 'REDIRECT') {
    // Ordinarily, we'd wait for the callback to be handled here,
    // but in our conformance provider, we get the authorization code
    // during the redirect handling, so we can go straight to
    // retrying the auth step.
    // await provider.waitForCallback();

    const authorizationCode = await provider.getAuthCode();

    // TODO: this retry logic should be incorporated into the typescript SDK
    result = await auth(provider, {
      serverUrl,
      resourceMetadataUrl,
      scope,
      authorizationCode,
      fetchFn: next
    });
    if (result !== 'AUTHORIZED') {
      throw new UnauthorizedError(
        `Authentication failed with result: ${result}`
      );
    }
  }
};
/**
 * Creates a fetch wrapper that handles OAuth authentication with retry logic.
 *
 * Unlike the SDK's withOAuth, this version:
 * - Automatically handles authorization redirects by retrying with fresh tokens
 * - Does not throw UnauthorizedError on redirect, but instead retries
 * - Calls next() instead of throwing for redirect-based auth
 *
 * @param provider - OAuth client provider for authentication
 * @param baseUrl - Base URL for OAuth server discovery (defaults to request URL domain)
 * @returns A fetch middleware function
 */
export const withOAuthRetry = (
  clientName: string,
  baseUrl?: string | URL,
  handle401Fn: typeof handle401 = handle401,
  clientMetadataUrl?: string
): Middleware => {
  const provider = new ConformanceOAuthProvider(
    'http://localhost:3000/callback',
    {
      client_name: clientName,
      redirect_uris: ['http://localhost:3000/callback']
    },
    clientMetadataUrl
  );
  return (next: FetchLike) => {
    return async (
      input: string | URL,
      init?: RequestInit
    ): Promise<Response> => {
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
      if (response.status === 401 || response.status === 403) {
        const serverUrl =
          baseUrl ||
          (typeof input === 'string' ? new URL(input).origin : input.origin);
        await handle401Fn(response, provider, next, serverUrl);

        response = await makeRequest();
      }

      // If we still have a 401 after re-auth attempt, throw an error
      if (response.status === 401 || response.status === 403) {
        const url = typeof input === 'string' ? input : input.toString();
        throw new UnauthorizedError(`Authentication failed for ${url}`);
      }

      return response;
    };
  };
};
