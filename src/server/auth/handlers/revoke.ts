import { OAuthServerProvider } from "../provider.js";
import type { RequestHandler } from "express";
import cors from "cors";
import { authenticateClient } from "../middleware/clientAuth.js";
import { OAuthTokenRevocationRequestSchema } from "../../../shared/auth.js";
import { rateLimit, Options as RateLimitOptions } from "express-rate-limit";
import { allowedMethods } from "../middleware/allowedMethods.js";
import {
  InvalidRequestError,
  ServerError,
  TooManyRequestsError,
  OAuthError,
} from "../errors.js";
import { noopMiddleware } from "../middleware/noop.js";
import { urlEncoded } from "../middleware/body.js";

export type RevocationHandlerOptions = {
  provider: OAuthServerProvider;
  /**
   * Rate limiting configuration for the token revocation endpoint.
   * Set to false to disable rate limiting for this endpoint.
   */
  rateLimit?: Partial<RateLimitOptions> | false;
};

export function revocationHandler({
  provider,
  rateLimit: rateLimitConfig,
}: RevocationHandlerOptions): RequestHandler {
  if (!provider.revokeToken) {
    throw new Error("Auth provider does not support revoking tokens");
  }

  const rateLimiter = rateLimitConfig === false ? noopMiddleware : rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // 50 requests per windowMs 
    standardHeaders: true,
    legacyHeaders: false,
    message: new TooManyRequestsError('You have exceeded the rate limit for token requests').toResponseObject(),
    ...rateLimitConfig
  });

  return (req, res) => {
    cors()(req, res, () => {
      allowedMethods(["POST"])(req, res, () => {
        urlEncoded(req, res, () => {
          rateLimiter(req, res, () => {
            authenticateClient({ clientsStore: provider.clientsStore })(req, res, async () => {
              res.setHeader("Cache-Control", "no-store");

              try {
                const parseResult = OAuthTokenRevocationRequestSchema.safeParse(req.body);
                if (!parseResult.success) {
                  throw new InvalidRequestError(parseResult.error.message);
                }

                const client = req.client;
                if (!client) {
                  // This should never happen
                  throw new ServerError("Internal Server Error");
                }

                await provider.revokeToken!(client, parseResult.data);
                res.status(200).json({});
              } catch (error) {
                if (error instanceof OAuthError) {
                  const status = error instanceof ServerError ? 500 : 400;
                  res.status(status).json(error.toResponseObject());
                } else {
                  const serverError = new ServerError("Internal Server Error");
                  res.status(500).json(serverError.toResponseObject());
                }
              }
            })
          })
        })
      })
    })
  }
}
