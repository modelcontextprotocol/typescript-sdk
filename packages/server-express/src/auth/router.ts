import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';

import type { AuthMetadataOptions, AuthRouterOptions, WebHandlerContext } from '@modelcontextprotocol/server';
import {
    mcpAuthMetadataRouter as createWebAuthMetadataRouter,
    mcpAuthRouter as createWebAuthRouter,
    TooManyRequestsError
} from '@modelcontextprotocol/server';
import type { RequestHandler, Response as ExpressResponse } from 'express';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

type ExpressRequestLike = IncomingMessage & {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    originalUrl?: string;
    url?: string;
    protocol?: string;
    // express adds this when trust proxy is enabled
    ip?: string;
    body?: unknown;
    get?: (name: string) => string | undefined;
};

function expressRequestUrl(req: ExpressRequestLike): URL {
    const host = req.get?.('host') ?? req.headers.host ?? 'localhost';
    const proto = req.protocol ?? 'http';
    const path = req.originalUrl ?? req.url ?? '/';
    return new URL(path, `${proto}://${host}`);
}

function toHeaders(req: ExpressRequestLike): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            headers.set(key, value.join(', '));
        } else {
            headers.set(key, value);
        }
    }
    return headers;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function expressToWebRequest(req: ExpressRequestLike, parsedBodyProvided: boolean): Promise<Request> {
    const url = expressRequestUrl(req);
    const headers = toHeaders(req);

    // If upstream body parsing ran, the Node stream is likely consumed.
    if (parsedBodyProvided) {
        return new Request(url, { method: req.method, headers });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
        return new Request(url, { method: req.method, headers });
    }

    const body = await readBody(req);
    return new Request(url, { method: req.method, headers, body });
}

async function writeWebResponse(res: ExpressResponse, webResponse: Response): Promise<void> {
    res.status(webResponse.status);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getSetCookie = (webResponse.headers as any).getSetCookie as (() => string[]) | undefined;
    const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(webResponse.headers) : undefined;

    for (const [key, value] of webResponse.headers.entries()) {
        if (key.toLowerCase() === 'set-cookie' && setCookies?.length) continue;
        res.setHeader(key, value);
    }

    if (setCookies?.length) {
        res.setHeader('set-cookie', setCookies);
    }

    res.flushHeaders?.();

    if (!webResponse.body) {
        res.end();
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const readable = Readable.fromWeb(webResponse.body as unknown as ReadableStream);
        readable.on('error', err => {
            try {
                res.destroy(err as Error);
            } catch {
                // ignore
            }
            reject(err);
        });
        res.on('error', reject);
        res.on('close', () => {
            try {
                readable.destroy();
            } catch {
                // ignore
            }
        });
        readable.pipe(res);
        res.on('finish', () => resolve());
    });
}

function toHandlerContext(req: ExpressRequestLike): WebHandlerContext {
    return {
        parsedBody: req.body
    };
}

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
                const parsedBodyProvided = (req as ExpressRequestLike).body !== undefined;
                const webReq = await expressToWebRequest(req as ExpressRequestLike, parsedBodyProvided);
                const webRes = await route.handler(webReq, toHandlerContext(req as ExpressRequestLike));
                await writeWebResponse(res, webRes);
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
                const parsedBodyProvided = (req as ExpressRequestLike).body !== undefined;
                const webReq = await expressToWebRequest(req as ExpressRequestLike, parsedBodyProvided);
                const webRes = await route.handler(webReq, toHandlerContext(req as ExpressRequestLike));
                await writeWebResponse(res, webRes);
            } catch (err) {
                next(err);
            }
        });
    }

    return router;
}
