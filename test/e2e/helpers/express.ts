/**
 * Express helper for hosting-related e2e tests.
 *
 * Builds real Express apps with SDK middleware, listens on ephemeral ports,
 * closes cleanly. Used by hosting-express.ts scenarios.
 */

import type { Server as HttpServer } from 'node:http';

import { hostHeaderValidation } from '@modelcontextprotocol/express';
import type { Express, RequestHandler } from 'express';
import express from 'express';

export interface ExpressHost extends AsyncDisposable {
    readonly baseUrl: URL;
    close(): Promise<void>;
}

async function listen(app: Express, host = '127.0.0.1'): Promise<{ baseUrl: URL; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
        const server: HttpServer = app.listen(0, host, () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error(`listen failed: ${addr}`));
                return;
            }
            resolve({
                baseUrl: new URL(`http://${host}:${addr.port}`),
                close: () =>
                    new Promise((res, rej) => {
                        server.close(err => (err ? rej(err) : res()));
                    })
            });
        });
        server.on('error', reject);
    });
}

export async function startExpressMinimal(handler: RequestHandler): Promise<ExpressHost> {
    const app = express();
    app.use(express.json());
    app.use(handler);

    const { baseUrl, close } = await listen(app);
    return {
        baseUrl,
        close,
        [Symbol.asyncDispose]: close
    };
}

export async function startExpressWithHostValidation(allowedHosts: string[], handler: RequestHandler): Promise<ExpressHost> {
    const app = express();
    app.use(express.json());
    app.use(hostHeaderValidation(allowedHosts));
    app.use(handler);

    const { baseUrl, close } = await listen(app);
    return {
        baseUrl,
        close,
        [Symbol.asyncDispose]: close
    };
}
