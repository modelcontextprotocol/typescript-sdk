import express, { RequestHandler } from 'express';
import { OAuthClientInformationFull, OAuthClientMetadataSchema } from '../../../shared/auth.js';
import crypto from 'node:crypto';
import cors from 'cors';
import { OAuthRegisteredClientsStore } from '../clients.js';
import { rateLimit, Options as RateLimitOptions } from 'express-rate-limit';
import { allowedMethods } from '../middleware/allowedMethods.js';
import { InvalidClientMetadataError, ServerError, TooManyRequestsError, OAuthError } from '../errors.js';

export type ClientRegistrationHandlerOptions = {
    /**
     * A store used to save information about dynamically registered OAuth clients.
     */
    clientsStore: OAuthRegisteredClientsStore;

    /**
     * The number of seconds after which to expire issued client secrets.
     * - If set to a positive number, client secrets will expire after that many seconds.
     * - If set to 0, client_secret_expires_at will be 0 (meaning no expiration per RFC 7591).
     * - If not set (undefined), client_secret_expires_at will be omitted from the response (no expiration).
     *
     * Defaults to undefined (no expiration), consistent with Python SDK behavior.
     */
    clientSecretExpirySeconds?: number;

    /**
     * Rate limiting configuration for the client registration endpoint.
     * Set to false to disable rate limiting for this endpoint.
     * Registration endpoints are particularly sensitive to abuse and should be rate limited.
     */
    rateLimit?: Partial<RateLimitOptions> | false;

    /**
     * Whether to generate a client ID before calling the client registration endpoint.
     *
     * If not set, defaults to true.
     */
    clientIdGeneration?: boolean;
};

export function clientRegistrationHandler({
    clientsStore,
    clientSecretExpirySeconds,
    rateLimit: rateLimitConfig,
    clientIdGeneration = true
}: ClientRegistrationHandlerOptions): RequestHandler {
    if (!clientsStore.registerClient) {
        throw new Error('Client registration store does not support registering clients');
    }

    // Nested router so we can configure middleware and restrict HTTP method
    const router = express.Router();

    // Configure CORS to allow any origin, to make accessible to web-based MCP clients
    router.use(cors());

    router.use(allowedMethods(['POST']));
    router.use(express.json());

    // Apply rate limiting unless explicitly disabled - stricter limits for registration
    if (rateLimitConfig !== false) {
        router.use(
            rateLimit({
                windowMs: 60 * 60 * 1000, // 1 hour
                max: 20, // 20 requests per hour - stricter as registration is sensitive
                standardHeaders: true,
                legacyHeaders: false,
                message: new TooManyRequestsError('You have exceeded the rate limit for client registration requests').toResponseObject(),
                ...rateLimitConfig
            })
        );
    }

    router.post('/', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        try {
            const parseResult = OAuthClientMetadataSchema.safeParse(req.body);
            if (!parseResult.success) {
                throw new InvalidClientMetadataError(parseResult.error.message);
            }

            const clientMetadata = parseResult.data;
            const isPublicClient = clientMetadata.token_endpoint_auth_method === 'none';

            // Generate client credentials
            const clientSecret = isPublicClient ? undefined : crypto.randomBytes(32).toString('hex');
            const clientIdIssuedAt = Math.floor(Date.now() / 1000);

            // Calculate client secret expiry time
            // - undefined: omit client_secret_expires_at (no expiration)
            // - 0: set to 0 (no expiration per RFC 7591)
            // - positive number: set to now + seconds
            let clientSecretExpiresAt: number | undefined;
            if (!isPublicClient) {
                if (clientSecretExpirySeconds !== undefined && clientSecretExpirySeconds > 0) {
                    clientSecretExpiresAt = clientIdIssuedAt + clientSecretExpirySeconds;
                } else if (clientSecretExpirySeconds === 0) {
                    clientSecretExpiresAt = 0;
                }
                // else: undefined - omit from response (no expiration)
            }

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
            res.status(201).json(clientInfo);
        } catch (error) {
            if (error instanceof OAuthError) {
                const status = error instanceof ServerError ? 500 : 400;
                res.status(status).json(error.toResponseObject());
            } else {
                const serverError = new ServerError('Internal Server Error');
                res.status(500).json(serverError.toResponseObject());
            }
        }
    });

    return router;
}
