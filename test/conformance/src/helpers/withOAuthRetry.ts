import type { AuthRequestContext, FetchLike, Middleware } from '@modelcontextprotocol/client';
import {
    adaptOAuthProvider,
    auth,
    computeScopeUnion,
    extractWWWAuthenticateParams,
    isStrictScopeSuperset,
    UnauthorizedError
} from '@modelcontextprotocol/client';

import { ConformanceOAuthProvider } from './conformanceOAuthProvider';

export const handle401 = async (
    response: Response,
    provider: ConformanceOAuthProvider,
    next: FetchLike,
    serverUrl: string | URL
): Promise<void> => {
    const { resourceMetadataUrl, scope: challengedScope } = extractWWWAuthenticateParams(response);
    // On a 403 insufficient_scope step-up, request the union of the previously
    // granted scope and the challenged scope so the existing permissions are
    // preserved (SEP-2350). On the initial 401 there is no prior token, so the
    // union degenerates to the challenged scope.
    const previousTokens = await provider.tokens();
    const scope = response.status === 403 ? computeScopeUnion(previousTokens?.scope, challengedScope) : challengedScope;
    // A 401 after we already held a token means it no longer authenticates the resource;
    // drop cached discovery so auth() re-probes PRM and can detect an authorization-server
    // migration (SEP-2352). 403 is a step-up at the same AS — keep the cache.
    if (response.status === 401) {
        provider.invalidateCredentials('discovery');
    }
    let result = await auth(provider, {
        serverUrl,
        resourceMetadataUrl,
        scope,
        // SEP-2350: when the union strictly exceeds the current token's granted scope,
        // a refresh cannot widen it (RFC 6749 §6) — bypass refresh and re-authorize.
        forceReauthorization: isStrictScopeSuperset(scope, previousTokens?.scope),
        fetchFn: next
    });

    if (result === 'REDIRECT') {
        // Ordinarily, we'd wait for the callback to be handled here,
        // but in our conformance provider, we get the authorization code
        // during the redirect handling, so we can go straight to
        // retrying the auth step.
        // await provider.waitForCallback();

        const authorizationCode = await provider.getAuthCode();
        const iss = provider.getIss();

        // TODO: this retry logic should be incorporated into the typescript SDK
        result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            scope,
            authorizationCode,
            iss,
            fetchFn: next
        });
        if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(`Authentication failed with result: ${result}`);
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
 * @param clientName - `client_name` for the auto-created ConformanceOAuthProvider (ignored when `existingProvider` is supplied)
 * @param baseUrl - Base URL for OAuth server discovery (defaults to request URL origin)
 * @param handle401Fn - Challenge handler invoked on 401/403 (defaults to {@link handle401})
 * @param clientMetadataUrl - CIMD URL for the auto-created provider (ignored when `existingProvider` is supplied)
 * @param existingProvider - Pre-populated provider; when set, `clientName`/`clientMetadataUrl` are unused
 * @returns A fetch middleware function
 */
export const withOAuthRetry = (
    clientName: string,
    baseUrl?: string | URL,
    handle401Fn: typeof handle401 = handle401,
    clientMetadataUrl?: string,
    existingProvider?: ConformanceOAuthProvider
): Middleware => {
    const provider =
        existingProvider ??
        new ConformanceOAuthProvider(
            'http://localhost:3000/callback',
            {
                client_name: clientName,
                redirect_uris: ['http://localhost:3000/callback']
            },
            clientMetadataUrl
        );
    // Delegates request-signing to the same authorizeRequest/consumeChallenge logic the SDK's
    // transports use, so a provider with a `dpop()` session (see helpers/dpopClient.ts) presents
    // the token with the DPoP scheme plus a per-request proof instead of Bearer — with no other
    // change to this middleware. A provider without `dpop()` keeps the exact prior Bearer behavior.
    const authProvider = adaptOAuthProvider(provider);
    return (next: FetchLike) => {
        return async (input: string | URL, init?: RequestInit): Promise<Response> => {
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
            // re-authorization (401 or 403 step-up) — tried in *whichever order the server
            // actually challenges them*. Both orders are real: a not-yet-authenticated request
            // gets the credential retry first and only discovers the RS's nonce requirement once
            // it presents a valid token (auth/dpop-nonce's shape); a request that already holds a
            // valid token but stale nonce state gets the nonce retry first. Neither retry is
            // spent more than once, so this loop runs at most twice before falling through to the
            // final check below — see the matching comment in the SDK's `withOAuth`
            // (packages/client/src/client/middleware.ts), which has the identical shape.
            let usedNonceRetry = false;
            let usedCredentialRetry = false;
            while ((response.status === 401 || response.status === 403) && (!usedNonceRetry || !usedCredentialRetry)) {
                // RFC 9449 §9: a DPoP `use_dpop_nonce` challenge is not a credential failure.
                if (!usedNonceRetry && (await authProvider.consumeChallenge?.(response, ctx))) {
                    usedNonceRetry = true;
                    response = await makeRequest();
                    continue;
                }
                if (usedCredentialRetry) break;
                usedCredentialRetry = true;
                const serverUrl = baseUrl || ctx.url.origin;
                await handle401Fn(response, provider, next, serverUrl);
                response = await makeRequest();
            }

            // If we still have a 401/403 after both retry budgets are spent, throw an error
            if (response.status === 401 || response.status === 403) {
                throw new UnauthorizedError(`Authentication failed for ${ctx.url}`);
            }

            return response;
        };
    };
};
