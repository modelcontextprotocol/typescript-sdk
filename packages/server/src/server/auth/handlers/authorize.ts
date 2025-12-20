import { InvalidClientError, InvalidRequestError, OAuthError, ServerError, TooManyRequestsError } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import type { OAuthServerProvider } from '../provider.js';
import type { WebHandler } from '../web.js';
import { getClientAddress, getParsedBody, InMemoryRateLimiter, jsonResponse, methodNotAllowedResponse, noStoreHeaders } from '../web.js';

export type AuthorizationHandlerOptions = {
    provider: OAuthServerProvider;
    /**
     * Rate limiting configuration for the authorization endpoint.
     * Set to false to disable rate limiting for this endpoint.
     */
    rateLimit?: Partial<{ windowMs: number; max: number }> | false;
};

// Parameters that must be validated in order to issue redirects.
const ClientAuthorizationParamsSchema = z.object({
    client_id: z.string(),
    redirect_uri: z
        .string()
        .optional()
        .refine(value => value === undefined || URL.canParse(value), { message: 'redirect_uri must be a valid URL' })
});

// Parameters that must be validated for a successful authorization request. Failure can be reported to the redirect URI.
const RequestAuthorizationParamsSchema = z.object({
    response_type: z.literal('code'),
    code_challenge: z.string(),
    code_challenge_method: z.literal('S256'),
    scope: z.string().optional(),
    state: z.string().optional(),
    resource: z.string().url().optional()
});

export function authorizationHandler({ provider, rateLimit: rateLimitConfig }: AuthorizationHandlerOptions): WebHandler {
    const limiter =
        rateLimitConfig === false
            ? undefined
            : new InMemoryRateLimiter({
                  windowMs: rateLimitConfig?.windowMs ?? 15 * 60 * 1000,
                  max: rateLimitConfig?.max ?? 100
              });

    return async (req, ctx) => {
        const noStore = noStoreHeaders();

        // Rate limit by client address where possible (best-effort).
        if (limiter) {
            const key = `${getClientAddress(req, ctx) ?? 'global'}:authorize`;
            const rl = limiter.consume(key);
            if (!rl.allowed) {
                return jsonResponse(
                    new TooManyRequestsError('You have exceeded the rate limit for authorization requests').toResponseObject(),
                    {
                        status: 429,
                        headers: {
                            ...noStore,
                            ...(rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : {})
                        }
                    }
                );
            }
        }

        if (req.method !== 'GET' && req.method !== 'POST') {
            const resp = methodNotAllowedResponse(req, ['GET', 'POST']);
            const body = await resp.text();
            return new Response(body, {
                status: resp.status,
                headers: { ...Object.fromEntries(resp.headers.entries()), ...noStore }
            });
        }

        // In the authorization flow, errors are split into two categories:
        // 1. Pre-redirect errors (direct response with 400)
        // 2. Post-redirect errors (redirect with error parameters)

        // Phase 1: Validate client_id and redirect_uri. Any errors here must be direct responses.
        let client_id, redirect_uri, client;
        try {
            const source =
                req.method === 'POST' ? await getParsedBody(req, ctx) : Object.fromEntries(new URL(req.url).searchParams.entries());
            const result = ClientAuthorizationParamsSchema.safeParse(source);
            if (!result.success) {
                throw new InvalidRequestError(result.error.message);
            }

            client_id = result.data.client_id;
            redirect_uri = result.data.redirect_uri;

            client = await provider.clientsStore.getClient(client_id);
            if (!client) {
                throw new InvalidClientError('Invalid client_id');
            }

            if (redirect_uri !== undefined) {
                if (!client.redirect_uris.includes(redirect_uri)) {
                    throw new InvalidRequestError('Unregistered redirect_uri');
                }
            } else if (client.redirect_uris.length === 1) {
                redirect_uri = client.redirect_uris[0];
            } else {
                throw new InvalidRequestError('redirect_uri must be specified when client has multiple registered URIs');
            }
        } catch (error) {
            // Pre-redirect errors - return direct response
            //
            // These don't need to be JSON encoded, as they'll be displayed in a user
            // agent, but OTOH they all represent exceptional situations (arguably,
            // "programmer error"), so presenting a nice HTML page doesn't help the
            // user anyway.
            if (error instanceof OAuthError) {
                const status = error instanceof ServerError ? 500 : 400;
                return jsonResponse(error.toResponseObject(), { status, headers: noStore });
            } else {
                const serverError = new ServerError('Internal Server Error');
                return jsonResponse(serverError.toResponseObject(), { status: 500, headers: noStore });
            }
        }

        // Phase 2: Validate other parameters. Any errors here should go into redirect responses.
        let state;
        try {
            // Parse and validate authorization parameters
            const source =
                req.method === 'POST' ? await getParsedBody(req, ctx) : Object.fromEntries(new URL(req.url).searchParams.entries());
            const parseResult = RequestAuthorizationParamsSchema.safeParse(source);
            if (!parseResult.success) {
                throw new InvalidRequestError(parseResult.error.message);
            }

            const { scope, code_challenge, resource } = parseResult.data;
            state = parseResult.data.state;

            // Validate scopes
            let requestedScopes: string[] = [];
            if (scope !== undefined) {
                requestedScopes = scope.split(' ');
            }

            // All validation passed, proceed with authorization
            const providerResponse = await provider.authorize(client, {
                state,
                scopes: requestedScopes,
                redirectUri: redirect_uri!, // TODO: Someone to look at. Strict tsconfig showed this could be undefined, while the return type is string.
                codeChallenge: code_challenge,
                resource: resource ? new URL(resource) : undefined
            });
            const headers = new Headers(providerResponse.headers);
            headers.set('Cache-Control', 'no-store');
            return new Response(providerResponse.body, { status: providerResponse.status, headers });
        } catch (error) {
            // Post-redirect errors - redirect with error parameters
            if (error instanceof OAuthError) {
                const location = createErrorRedirect(redirect_uri!, error, state);
                return new Response(null, { status: 302, headers: { Location: location, ...noStore } });
            } else {
                const serverError = new ServerError('Internal Server Error');
                const location = createErrorRedirect(redirect_uri!, serverError, state);
                return new Response(null, { status: 302, headers: { Location: location, ...noStore } });
            }
        }
    };
}

/**
 * Helper function to create redirect URL with error parameters
 */
function createErrorRedirect(redirectUri: string, error: OAuthError, state?: string): string {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set('error', error.errorCode);
    errorUrl.searchParams.set('error_description', error.message);
    if (error.errorUri) {
        errorUrl.searchParams.set('error_uri', error.errorUri);
    }
    if (state) {
        errorUrl.searchParams.set('state', state);
    }
    return errorUrl.href;
}
