import {
    InvalidRequestError,
    OAuthError,
    OAuthTokenRevocationRequestSchema,
    ServerError,
    TooManyRequestsError
} from '@modelcontextprotocol/core';

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

export type RevocationHandlerOptions = {
    provider: OAuthServerProvider;
    /**
     * Rate limiting configuration for the token revocation endpoint.
     * Set to false to disable rate limiting for this endpoint.
     */
    rateLimit?: Partial<{ windowMs: number; max: number }> | false;
};

export function revocationHandler({ provider, rateLimit: rateLimitConfig }: RevocationHandlerOptions): WebHandler {
    if (!provider.revokeToken) {
        throw new Error('Auth provider does not support revoking tokens');
    }

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
            const key = `${getClientAddress(req, ctx) ?? 'global'}:revoke`;
            const rl = limiter.consume(key);
            if (!rl.allowed) {
                return jsonResponse(
                    new TooManyRequestsError('You have exceeded the rate limit for token revocation requests').toResponseObject(),
                    {
                        status: 429,
                        headers: {
                            ...baseHeaders,
                            ...(rl.retryAfterSeconds ? { 'Retry-After': String(rl.retryAfterSeconds) } : {})
                        }
                    }
                );
            }
        }

        try {
            const rawBody = await getParsedBody(req, ctx);
            const parseResult = OAuthTokenRevocationRequestSchema.safeParse(rawBody);
            if (!parseResult.success) {
                throw new InvalidRequestError(parseResult.error.message);
            }

            const client = await authenticateClient(rawBody, { clientsStore: provider.clientsStore });

            await provider.revokeToken!(client, parseResult.data);
            return jsonResponse({}, { status: 200, headers: baseHeaders });
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
