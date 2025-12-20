import type { AuthMetadataOptions, AuthRouterOptions } from '@modelcontextprotocol/server';
import {
    getParsedBody,
    mcpAuthMetadataRouter as createWebAuthMetadataRouter,
    mcpAuthRouter as createWebAuthRouter,
    TooManyRequestsError
} from '@modelcontextprotocol/server';
import { createRequest, sendResponse } from '@remix-run/node-fetch-server';
import type { RequestHandler } from 'express';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

export type ExpressAuthRateLimitOptions =
    | false
    | {
          /**
           * Window size in ms (default: 60s)
           */
          windowMs?: number;
          /**
           * Max requests per window per client (default: 60)
           */
          max?: number;
      };

/**
 * Express router adapter for the Web-standard `mcpAuthRouter` from `@modelcontextprotocol/server`.
 *
 * IMPORTANT: This router MUST be mounted at the application root, like:
 *
 * ```ts
 * app.use(mcpAuthRouter(...))
 * ```
 */
export function mcpAuthRouter(options: AuthRouterOptions & { rateLimit?: ExpressAuthRateLimitOptions }): RequestHandler {
    const web = createWebAuthRouter(options);
    const router = express.Router();

    const rateLimitOptions = options.rateLimit;
    const limiter =
        rateLimitOptions === false
            ? undefined
            : rateLimit({
                  windowMs: rateLimitOptions?.windowMs ?? 60_000,
                  max: rateLimitOptions?.max ?? 60,
                  standardHeaders: true,
                  legacyHeaders: false,
                  handler: (_req, res) => {
                      const err = new TooManyRequestsError('Too many requests');
                      res.status(429).json(err.toResponseObject());
                  }
              });

    const isRateLimitedPath = (path: string): boolean =>
        path === '/authorize' || path === '/token' || path === '/register' || path === '/revoke';

    for (const route of web.routes) {
        const handlers: RequestHandler[] = [];
        if (limiter && isRateLimitedPath(route.path)) {
            handlers.push(limiter);
        }
        handlers.push(async (req, res, next) => {
            try {
                const webReq = createRequest(req, res);
                const parsedBody = req.body !== undefined ? req.body : await getParsedBody(webReq);
                const webRes = await route.handler(webReq, { parsedBody });
                await sendResponse(res, webRes);
            } catch (err) {
                next(err);
            }
        });
        router.all(route.path, ...handlers);
    }

    return router;
}

/**
 * Express router adapter for the Web-standard `mcpAuthMetadataRouter` from `@modelcontextprotocol/server`.
 *
 * IMPORTANT: This router MUST be mounted at the application root.
 */
export function mcpAuthMetadataRouter(options: AuthMetadataOptions): RequestHandler {
    const web = createWebAuthMetadataRouter(options);
    const router = express.Router();

    for (const route of web.routes) {
        router.all(route.path, async (req, res, next) => {
            try {
                const webReq = createRequest(req, res);
                const parsedBody = req.body !== undefined ? req.body : await getParsedBody(webReq);
                const webRes = await route.handler(webReq, { parsedBody });
                await sendResponse(res, webRes);
            } catch (err) {
                next(err);
            }
        });
    }

    return router;
}
