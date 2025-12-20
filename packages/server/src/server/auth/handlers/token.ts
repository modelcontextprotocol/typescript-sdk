import {
    InvalidGrantError,
    InvalidRequestError,
    OAuthError,
    ServerError,
    TooManyRequestsError,
    UnsupportedGrantTypeError
} from '@modelcontextprotocol/core';
import { verifyChallenge } from 'pkce-challenge';
import * as z from 'zod/v4';

import { authenticateClient } from '../middleware/clientAuth.js';
import type { OAuthServerProvider } from '../provider.js';
import type { WebHandler } from '../web.js';
import {
    corsHeaders,
    corsPreflightResponse,
    getClientAddress,
    getParsedBody,
    InMemoryRateLimiter,
    jsonResponse,
    methodNotAllowedResponse,
    noStoreHeaders
} from '../web.js';

export type TokenHandlerOptions = {
    provider: OAuthServerProvider;
    /**
     * Rate limiting configuration for the token endpoint.
     * Set to false to disable rate limiting for this endpoint.
     */
    rateLimit?: Partial<{ windowMs: number; max: number }> | false;
};

const TokenRequestSchema = z.object({
    grant_type: z.string()
});

const AuthorizationCodeGrantSchema = z.object({
    code: z.string(),
    code_verifier: z.string(),
    redirect_uri: z.string().optional(),
    resource: z.string().url().optional()
});

const RefreshTokenGrantSchema = z.object({
    refresh_token: z.string(),
    scope: z.string().optional(),
    resource: z.string().url().optional()
});

export function tokenHandler({ provider, rateLimit: rateLimitConfig }: TokenHandlerOptions): WebHandler {
    const limiter =
        rateLimitConfig === false
            ? undefined
            : new InMemoryRateLimiter({
                  windowMs: rateLimitConfig?.windowMs ?? 15 * 60 * 1000,
                  max: rateLimitConfig?.max ?? 50
              });

    const cors = {
        allowOrigin: '*',
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAgeSeconds: 60 * 60 * 24
    } as const;

    return async (req, ctx) => {
        const baseHeaders = { ...corsHeaders(cors), ...noStoreHeaders() };

        if (req.method === 'OPTIONS') {
            return corsPreflightResponse(cors);
        }
        if (req.method !== 'POST') {
            const resp = methodNotAllowedResponse(req, ['POST', 'OPTIONS']);
            const body = await resp.text();
            return new Response(body, {
                status: resp.status,
                headers: { ...Object.fromEntries(resp.headers.entries()), ...baseHeaders }
            });
        }

        if (limiter) {
            const key = `${getClientAddress(req, ctx) ?? 'global'}:token`;
            const rl = limiter.consume(key);
            if (!rl.allowed) {
                return jsonResponse(new TooManyRequestsError('You have exceeded the rate limit for token requests').toResponseObject(), {
                    status: 429,
                    headers: {
                        ...baseHeaders,
                        ...(rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : {})
                    }
                });
            }
        }

        try {
            const rawBody = await getParsedBody(req, ctx);
            const parseResult = TokenRequestSchema.safeParse(rawBody);
            if (!parseResult.success) {
                throw new InvalidRequestError(parseResult.error.message);
            }

            const { grant_type } = parseResult.data;

            const client = await authenticateClient(rawBody, { clientsStore: provider.clientsStore });

            switch (grant_type) {
                case 'authorization_code': {
                    const parseResult = AuthorizationCodeGrantSchema.safeParse(rawBody);
                    if (!parseResult.success) {
                        throw new InvalidRequestError(parseResult.error.message);
                    }

                    const { code, code_verifier, redirect_uri, resource } = parseResult.data;

                    const skipLocalPkceValidation = provider.skipLocalPkceValidation;

                    // Perform local PKCE validation unless explicitly skipped
                    // (e.g. to validate code_verifier in upstream server)
                    if (!skipLocalPkceValidation) {
                        const codeChallenge = await provider.challengeForAuthorizationCode(client, code);
                        if (!(await verifyChallenge(code_verifier, codeChallenge))) {
                            throw new InvalidGrantError('code_verifier does not match the challenge');
                        }
                    }

                    // Passes the code_verifier to the provider if PKCE validation didn't occur locally
                    const tokens = await provider.exchangeAuthorizationCode(
                        client,
                        code,
                        skipLocalPkceValidation ? code_verifier : undefined,
                        redirect_uri,
                        resource ? new URL(resource) : undefined
                    );
                    return jsonResponse(tokens, { status: 200, headers: baseHeaders });
                }

                case 'refresh_token': {
                    const parseResult = RefreshTokenGrantSchema.safeParse(rawBody);
                    if (!parseResult.success) {
                        throw new InvalidRequestError(parseResult.error.message);
                    }

                    const { refresh_token, scope, resource } = parseResult.data;

                    const scopes = scope?.split(' ');
                    const tokens = await provider.exchangeRefreshToken(
                        client,
                        refresh_token,
                        scopes,
                        resource ? new URL(resource) : undefined
                    );
                    return jsonResponse(tokens, { status: 200, headers: baseHeaders });
                }
                // Additional auth methods will not be added on the server side of the SDK.
                case 'client_credentials':
                default:
                    throw new UnsupportedGrantTypeError('The grant type is not supported by this authorization server.');
            }
        } catch (error) {
            if (error instanceof OAuthError) {
                const status = error instanceof ServerError ? 500 : 400;
                return jsonResponse(error.toResponseObject(), { status, headers: baseHeaders });
            }
            const serverError = new ServerError('Internal Server Error');
            return jsonResponse(serverError.toResponseObject(), { status: 500, headers: baseHeaders });
        }
    };
}
