import { ProtocolErrorCode } from '@modelcontextprotocol/core';

import { validateHostHeader } from './middleware/hostHeaderValidation.js';
import type { Server } from './server.js';
import type { StatelessHttpRequestOptions } from './statelessHttp.js';
import { jsonError, statelessHttpHandler } from './statelessHttp.js';

/** Options for {@linkcode handleHttp}. */
export interface HandleHttpOptions {
    /**
     * Hostnames to accept in the `Host` header (DNS-rebinding guard). When set, requests from other hosts are rejected with 403.
     * Port-agnostic; for IPv6 include brackets (e.g. `[::1]`). Same convention as {@linkcode validateHostHeader}.
     */
    allowedHosts?: string[];
    /** Origin header values to accept. When set, requests from other origins are rejected with 403. */
    allowedOrigins?: string[];
    /** Maximum POST body size. Default 4 MiB. */
    maxBodyBytes?: number;
    /** Called once per request to validate authorization. May throw or return `Response` to short-circuit. */
    auth?: (req: Request) => Promise<StatelessHttpRequestOptions['authInfo'] | Response | undefined>;
    /** See {@linkcode StatelessHttpRequestOptions.onAuthorizeResourceSubscription}. */
    onAuthorizeResourceSubscription?: StatelessHttpRequestOptions['onAuthorizeResourceSubscription'];
}

/**
 * 2026-06 Fetch-API HTTP entry. Returns a `(Request) → Promise<Response>`
 * handler that dispatches via the server's {@linkcode Server.dispatcher} and
 * {@linkcode Server.subscriptions}. No `Transport` instance, no `connect()`,
 * no per-connection state; one server instance can be shared across requests.
 *
 * Pre-2026 clients are NOT served by this entry (use the
 * `WebStandardStreamableHTTPServerTransport` router for both eras, or compose
 * both behind your own router).
 *
 * @example
 * ```ts
 * const mcp = new McpServer({ name: 'srv', version: '1.0.0' });
 * mcp.registerTool('echo', { ... }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
 * app.all('/mcp', (req) => handleHttp(mcp.server)(req));
 * ```
 */
export function handleHttp(server: Server, opts?: HandleHttpOptions): (req: Request) => Promise<Response> {
    const handlers = server.statelessHandlers();
    return async req => {
        // DNS-rebinding / origin checks BEFORE auth (do not invoke user auth
        // callback for requests from forbidden hosts/origins).
        if (opts?.allowedHosts) {
            const result = validateHostHeader(req.headers.get('host'), opts.allowedHosts);
            if (!result.ok) {
                return jsonError(403, ProtocolErrorCode.InvalidRequest, `Forbidden: ${result.message}`, null);
            }
        }
        const origin = req.headers.get('origin');
        if (opts?.allowedOrigins && (!origin || !opts.allowedOrigins.includes(origin))) {
            return jsonError(403, ProtocolErrorCode.InvalidRequest, 'Forbidden: missing or invalid Origin header', null);
        }

        let authInfo: StatelessHttpRequestOptions['authInfo'];
        if (opts?.auth) {
            const a = await opts.auth(req);
            if (a instanceof Response) return a;
            authInfo = a;
        }

        return statelessHttpHandler(handlers, req, {
            authInfo,
            maxBodyBytes: opts?.maxBodyBytes,
            onAuthorizeResourceSubscription: opts?.onAuthorizeResourceSubscription
        });
    };
}
