import type { FetchLike } from '../../../../src/shared/transport.js';
import type { Middleware } from '../../../../src/client/middleware.js';
import { auth, extractWWWAuthenticateParams, UnauthorizedError } from '../../../../src/client/auth.js';

import { ConformanceOAuthProvider } from './conformanceOAuthProvider.js';

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
        const authorizationCode = await provider.getAuthCode();

        result = await auth(provider, {
            serverUrl,
            resourceMetadataUrl,
            scope,
            authorizationCode,
            fetchFn: next
        });
        if (result !== 'AUTHORIZED') {
            throw new UnauthorizedError(`Authentication failed with result: ${result}`);
        }
    }
};

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
    return (next: FetchLike) => {
        return async (input: string | URL, init?: RequestInit): Promise<Response> => {
            const makeRequest = async (): Promise<Response> => {
                const headers = new Headers(init?.headers);

                const tokens = await provider.tokens();
                if (tokens) {
                    headers.set('Authorization', `Bearer ${tokens.access_token}`);
                }

                return await next(input, { ...init, headers });
            };

            let response = await makeRequest();

            if (response.status === 401 || response.status === 403) {
                const serverUrl = baseUrl || (typeof input === 'string' ? new URL(input).origin : input.origin);
                await handle401Fn(response, provider, next, serverUrl);

                response = await makeRequest();
            }

            if (response.status === 401 || response.status === 403) {
                const url = typeof input === 'string' ? input : input.toString();
                throw new UnauthorizedError(`Authentication failed for ${url}`);
            }

            return response;
        };
    };
};
