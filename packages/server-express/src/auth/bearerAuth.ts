import { URL } from 'node:url';

import type { AuthInfo } from '@modelcontextprotocol/core';
import type { BearerAuthMiddlewareOptions } from '@modelcontextprotocol/server';
import { requireBearerAuth as requireBearerAuthWeb } from '@modelcontextprotocol/server';
import type { NextFunction, Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from 'express';

declare module 'express-serve-static-core' {
    interface Request {
        /**
         * Information about the validated access token, if `requireBearerAuth` was used.
         */
        auth?: AuthInfo;
    }
}

function expressRequestUrl(req: ExpressRequest): URL {
    const host = req.get('host') ?? req.headers.host ?? 'localhost';
    const protocol = req.protocol ?? 'http';
    const path = req.originalUrl ?? req.url ?? '/';
    return new URL(path, `${protocol}://${host}`);
}

async function writeWebResponse(res: ExpressResponse, webResponse: Response): Promise<void> {
    res.status(webResponse.status);
    for (const [k, v] of webResponse.headers.entries()) {
        res.setHeader(k, v);
    }
    const bodyText = await webResponse.text();
    res.send(bodyText);
}

/**
 * Express middleware wrapper for the Web-standard `requireBearerAuth` helper.
 *
 * On success, sets `req.auth` and calls `next()`.
 * On failure, writes the JSON error response and ends the request.
 */
export function requireBearerAuth(options: BearerAuthMiddlewareOptions): RequestHandler {
    return async (req, res, next: NextFunction) => {
        try {
            const url = expressRequestUrl(req);
            const webReq = new Request(url, {
                method: req.method,
                headers: {
                    authorization: req.headers.authorization ?? ''
                }
            });

            const result = await requireBearerAuthWeb(webReq, options);
            if ('authInfo' in result) {
                req.auth = result.authInfo;
                next();
                return;
            }

            await writeWebResponse(res, result.response);
        } catch (err) {
            next(err);
        }
    };
}
