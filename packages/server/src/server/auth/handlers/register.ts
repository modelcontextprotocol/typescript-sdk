import crypto from 'node:crypto';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/core';
import {
    InvalidClientMetadataError,
    OAuthClientMetadataSchema,
    OAuthError,
    ServerError,
    TooManyRequestsError
} from '@modelcontextprotocol/core';

import type { OAuthRegisteredClientsStore } from '../clients.js';
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

export type ClientRegistrationHandlerOptions = {
    /**
     * A store used to save information about dynamically registered OAuth clients.
     */
    clientsStore: OAuthRegisteredClientsStore;

    /**
     * The number of seconds after which to expire issued client secrets, or 0 to prevent expiration of client secrets (not recommended).
     *
     * If not set, defaults to 30 days.
     */
    clientSecretExpirySeconds?: number;

    /**
     * Rate limiting configuration for the client registration endpoint.
     * Set to false to disable rate limiting for this endpoint.
     * Registration endpoints are particularly sensitive to abuse and should be rate limited.
     */
    rateLimit?: Partial<{ windowMs: number; max: number }> | false;

    /**
     * Whether to generate a client ID before calling the client registration endpoint.
     *
     * If not set, defaults to true.
     */
    clientIdGeneration?: boolean;
};

const DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function clientRegistrationHandler({
    clientsStore,
    clientSecretExpirySeconds = DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS,
    rateLimit: rateLimitConfig,
    clientIdGeneration = true
}: ClientRegistrationHandlerOptions): WebHandler {
    if (!clientsStore.registerClient) {
        throw new Error('Client registration store does not support registering clients');
    }

    const limiter =
        rateLimitConfig === false
            ? undefined
            : new InMemoryRateLimiter({
                  windowMs: rateLimitConfig?.windowMs ?? 60 * 60 * 1000,
                  max: rateLimitConfig?.max ?? 20
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
            const key = `${getClientAddress(req, ctx) ?? 'global'}:register`;
            const rl = limiter.consume(key);
            if (!rl.allowed) {
                return jsonResponse(
                    new TooManyRequestsError('You have exceeded the rate limit for client registration requests').toResponseObject(),
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
            const parseResult = OAuthClientMetadataSchema.safeParse(rawBody);
            if (!parseResult.success) {
                throw new InvalidClientMetadataError(parseResult.error.message);
            }

            const clientMetadata = parseResult.data;
            const isPublicClient = clientMetadata.token_endpoint_auth_method === 'none';

            // Generate client credentials
            const clientSecret = isPublicClient ? undefined : crypto.randomBytes(32).toString('hex');
            const clientIdIssuedAt = Math.floor(Date.now() / 1000);

            // Calculate client secret expiry time
            const clientsDoExpire = clientSecretExpirySeconds > 0;
            const secretExpiryTime = clientsDoExpire ? clientIdIssuedAt + clientSecretExpirySeconds : 0;
            const clientSecretExpiresAt = isPublicClient ? undefined : secretExpiryTime;

            let clientInfo: Omit<OAuthClientInformationFull, 'client_id'> & { client_id?: string } = {
                ...clientMetadata,
                client_secret: clientSecret,
                client_secret_expires_at: clientSecretExpiresAt
            };

            if (clientIdGeneration) {
                clientInfo.client_id = crypto.randomUUID();
                clientInfo.client_id_issued_at = clientIdIssuedAt;
            }

            clientInfo = await clientsStore.registerClient!(clientInfo);
            return jsonResponse(clientInfo, { status: 201, headers: baseHeaders });
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
