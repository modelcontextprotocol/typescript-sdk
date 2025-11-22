import * as z from 'zod/v4';
import { RequestHandler } from 'express';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { OAuthClientInformationFull } from '../../../shared/auth.js';
import { InvalidRequestError, InvalidClientError, ServerError, OAuthError } from '../errors.js';
import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify, JWTVerifyGetKey } from 'jose';

export type ClientAuthenticationMiddlewareOptions = {
    /**
     * A store used to read information about registered OAuth clients.
     */
    clientsStore: OAuthRegisteredClientsStore;
};

const ClientAuthenticatedRequestSchema = z.object({
    client_id: z.string(),
    client_secret: z.string().optional()
});

declare module 'express-serve-static-core' {
    interface Request {
        /**
         * The authenticated client for this request, if the `authenticateClient` middleware was used.
         */
        client?: OAuthClientInformationFull;
    }
}

export function authenticateClient({ clientsStore }: ClientAuthenticationMiddlewareOptions): RequestHandler {
    return async (req, res, next) => {
        try {
            // 1) HTTP Basic (client_secret_basic)
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.toLowerCase().startsWith('basic ')) {
                const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
                const sep = decoded.indexOf(':');
                const basicClientId = decoded.slice(0, sep);
                const basicClientSecret = decoded.slice(sep + 1);

                const client = await clientsStore.getClient(basicClientId);
                if (!client) {
                    throw new InvalidClientError('Invalid client_id');
                }
                if (!client.client_secret) {
                    throw new InvalidClientError('Client not configured for client_secret authentication');
                }
                if (client.client_secret !== basicClientSecret) {
                    throw new InvalidClientError('Invalid client_secret');
                }
                if (client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(Date.now() / 1000)) {
                    throw new InvalidClientError('Client secret has expired');
                }

                req.client = client;
                return next();
            }

            // 2) private_key_jwt via client_assertion
            const assertionType = typeof req.body?.client_assertion_type === 'string' ? req.body.client_assertion_type : undefined;
            const assertion = typeof req.body?.client_assertion === 'string' ? req.body.client_assertion : undefined;
            if (assertionType === 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' && assertion) {
                // Decode header to check alg
                const protectedHeader = decodeProtectedHeader(assertion);
                const alg = protectedHeader.alg || '';

                // Determine expected audience (token endpoint URL)
                const expectedAudience = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

                // We need a client_id to fetch client metadata; per RFC 7523, sub identifies the client
                // Verify using JWKS (embedded or remote), or HMAC secret for HS* algorithms
                // First, parse without verification to extract sub/iss would require more deps; instead verify
                // against all potential keys we can derive from request client_id if provided, otherwise defer to failure
                const candidateClientId = typeof req.body?.client_id === 'string' ? (req.body.client_id as string) : undefined;

                // If no client_id provided in body, attempt to verify against all known clients is not feasible.
                // Require client_id in body for now, or rely on iss/sub matching after verification.
                if (!candidateClientId) {
                    // We can still verify then read payload, but we need a key set.
                    // Without client hint, we cannot pick a key. Treat as invalid request.
                    throw new InvalidRequestError('client_id is required when using private_key_jwt');
                }

                const client = await clientsStore.getClient(candidateClientId);
                if (!client) {
                    throw new InvalidClientError('Invalid client_id');
                }

                // Build key for verification
                let keyOrGetKey: ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet> | Uint8Array | undefined;

                if (client.jwks) {
                    keyOrGetKey = createLocalJWKSet({ keys: client.jwks.keys ?? client.jwks });
                } else if (client.jwks_uri) {
                    try {
                        const jwksUrl = new URL(client.jwks_uri);
                        keyOrGetKey = createRemoteJWKSet(jwksUrl);
                    } catch {
                        throw new InvalidClientError('Invalid jwks_uri in client registration');
                    }
                } else if (alg && alg.startsWith('HS') && client.client_secret) {
                    keyOrGetKey = new TextEncoder().encode(client.client_secret);
                } else {
                    throw new InvalidClientError('No verification key available for private_key_jwt');
                }

                const { payload } = await jwtVerify(assertion, keyOrGetKey as JWTVerifyGetKey, {
                    audience: expectedAudience,
                    issuer: client.client_id
                });

                // Validate sub and iss
                if (payload.sub !== client.client_id) {
                    throw new InvalidClientError('Invalid client_assertion: subject does not match client_id');
                }

                req.client = client;
                return next();
            }

            // 3) client_secret_post (body params)
            const result = ClientAuthenticatedRequestSchema.safeParse(req.body);
            if (!result.success) {
                throw new InvalidRequestError(String(result.error));
            }
            const { client_id, client_secret } = result.data;
            const client = await clientsStore.getClient(client_id);
            if (!client) {
                throw new InvalidClientError('Invalid client_id');
            }
            if (client.client_secret) {
                if (!client_secret) {
                    throw new InvalidClientError('Client secret is required');
                }
                if (client.client_secret !== client_secret) {
                    throw new InvalidClientError('Invalid client_secret');
                }
                if (client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(Date.now() / 1000)) {
                    throw new InvalidClientError('Client secret has expired');
                }
            }

            req.client = client;
            next();
        } catch (error) {
            if (error instanceof OAuthError) {
                const status = error instanceof ServerError ? 500 : 400;
                res.status(status).json(error.toResponseObject());
            } else {
                const serverError = new ServerError('Internal Server Error');
                res.status(500).json(serverError.toResponseObject());
            }
        }
    };
}
