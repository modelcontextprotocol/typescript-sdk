import {
    InvalidRequestError,
    OAuthError,
    OAuthTokenRevocationRequestSchema,
    ServerError,
    TooManyRequestsError
} from '@modelcontextprotocol/core';
import cors from 'cors';
import type { RequestHandler } from 'express';
import express from 'express';
import type { Options as RateLimitOptions } from 'express-rate-limit';
import { rateLimit } from 'express-rate-limit';

import { allowedMethods } from '../middleware/allowedMethods.js';
import { authenticateClient } from '../middleware/clientAuth.js';
import type { OAuthServerProvider } from '../provider.js';

export type RevocationHandlerOptions = {
    provider: OAuthServerProvider;
    /**
     * Rate limiting configuration for the token revocation endpoint.
     * Set to false to disable rate limiting for this endpoint.
     */
    rateLimit?: Partial<RateLimitOptions> | false;
};

export function revocationHandler({ provider, rateLimit: rateLimitConfig }: RevocationHandlerOptions): RequestHandler {
    if (!provider.revokeToken) {
        throw new Error('Auth provider does not support revoking tokens');
    }

    // Nested router so we can configure middleware and restrict HTTP method
    const router = express.Router();

    // Configure CORS to allow any origin, to make accessible to web-based MCP clients
    router.use(cors());

    router.use(allowedMethods(['POST']));
    router.use(express.urlencoded({ extended: false }));

    // Apply rate limiting unless explicitly disabled
    if (rateLimitConfig !== false) {
        router.use(
            rateLimit({
                windowMs: 15 * 60 * 1000, // 15 minutes
                max: 50, // 50 requests per windowMs
                standardHeaders: true,
                legacyHeaders: false,
                message: new TooManyRequestsError('You have exceeded the rate limit for token revocation requests').toResponseObject(),
                ...rateLimitConfig
            })
        );
    }

    // Authenticate and extract client details
    router.use(authenticateClient({ clientsStore: provider.clientsStore }));

    router.post('/', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');

        try {
            const parseResult = OAuthTokenRevocationRequestSchema.safeParse(req.body);
            if (!parseResult.success) {
                throw new InvalidRequestError(parseResult.error.message);
            }

            const client = req.client;
            if (!client) {
                // This should never happen
                throw new ServerError('Internal Server Error');
            }

            await provider.revokeToken!(client, parseResult.data);
            res.status(200).json({});
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
