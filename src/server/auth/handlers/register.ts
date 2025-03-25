import express, { RequestHandler } from "express";
import { OAuthClientInformationFull, OAuthClientMetadataSchema } from "../../../shared/auth.js";
import crypto from 'node:crypto';
import cors from 'cors';
import { OAuthRegisteredClientsStore } from "../clients.js";
import { rateLimit, Options as RateLimitOptions } from "express-rate-limit";
import { allowedMethods } from "../middleware/allowedMethods.js";
import {
  InvalidClientMetadataError,
  ServerError,
  TooManyRequestsError,
  OAuthError
} from "../errors.js";

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
  rateLimit?: Partial<RateLimitOptions> | false;
};

const DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function clientRegistrationHandler({
  clientsStore,
  clientSecretExpirySeconds = DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS,
  rateLimit: rateLimitConfig
}: ClientRegistrationHandlerOptions): RequestHandler {
  if (!clientsStore.registerClient) {
    throw new Error("Client registration store does not support registering clients");
  }

  // Nested router so we can configure middleware and restrict HTTP method
  const router = express.Router();

  // Configure CORS to allow any origin, to make accessible to web-based MCP clients
  router.use(cors());

  router.use(allowedMethods(["POST"]));
  router.use(express.json());

  // Apply rate limiting unless explicitly disabled - stricter limits for registration
  if (rateLimitConfig !== false) {
    router.use(rateLimit({
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 20, // 20 requests per hour - stricter as registration is sensitive
      standardHeaders: true,
      legacyHeaders: false,
      message: new TooManyRequestsError('You have exceeded the rate limit for client registration requests').toResponseObject(),
      ...rateLimitConfig
    }));
  }

  router.post("/", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const parseResult = OAuthClientMetadataSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new InvalidClientMetadataError(parseResult.error.message);
      }

      const clientMetadata = parseResult.data;
      const isPublicClient = clientMetadata.token_endpoint_auth_method === 'none'

      // Generate client credentials
      const clientId = crypto.randomUUID();
      const clientSecret = isPublicClient
        ? undefined
        : crypto.randomBytes(32).toString('hex');
      const clientIdIssuedAt = Math.floor(Date.now() / 1000);

      // Calculate client secret expiry time
      const clientsDoExpire = clientSecretExpirySeconds > 0
      const secretExpiryTime = clientsDoExpire ? clientIdIssuedAt + clientSecretExpirySeconds : 0
      const clientSecretExpiresAt = isPublicClient ? undefined : secretExpiryTime

      let clientInfo: OAuthClientInformationFull = {
        ...clientMetadata,
        client_id: clientId,
        client_secret: clientSecret,
        client_id_issued_at: clientIdIssuedAt,
        client_secret_expires_at: clientSecretExpiresAt,
      };

      clientInfo = await clientsStore.registerClient!(clientInfo);
      res.status(201).json(clientInfo);
    } catch (error) {
      if (error instanceof OAuthError) {
        const status = error instanceof ServerError ? 500 : 400;
        res.status(status).json(error.toResponseObject());
      } else {
        console.error("Unexpected error registering client:", error);
        const serverError = new ServerError("Internal Server Error");
        res.status(500).json(serverError.toResponseObject());
      }
    }
  });

  return router;
}