import type { DispatchOutput, JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, RequestEnv } from '@modelcontextprotocol/core';

import type { ShttpHandlerOptions, ShttpRequestExtra } from './shttpHandler.js';
import { shttpHandler } from './shttpHandler.js';

async function* unwrap(gen: AsyncIterable<DispatchOutput>): AsyncGenerator<JSONRPCMessage, void, void> {
    for await (const out of gen) yield out.message;
}

/**
 * Minimal contract {@linkcode handleHttp} requires. Satisfied by `McpServer`,
 * `Server`, and any `Protocol` subclass.
 */
export interface Dispatchable {
    dispatch(request: JSONRPCRequest, env?: RequestEnv): AsyncIterable<DispatchOutput>;
    dispatchNotification(notification: JSONRPCNotification): Promise<void>;
}

/**
 * Mounts an `McpServer` (or any `Protocol`) as a web-standard
 * `(Request) => Response` handler. Use this to drive a server from an HTTP framework
 * without instantiating a transport class:
 *
 * ```ts
 * import { McpServer, handleHttp, SessionCompat } from '@modelcontextprotocol/server';
 * import { toNodeHttpHandler } from '@modelcontextprotocol/node';
 *
 * const mcp = new McpServer({ name: 's', version: '1.0.0' });
 * mcp.tool('search', schema, handler);
 *
 * app.all('/mcp', toNodeHttpHandler(handleHttp(mcp, { session: new SessionCompat() })));
 * ```
 *
 * `mcp.connect(transport)` is not called; each HTTP request flows through
 * `mcp.dispatch()` directly. Supply a `SessionCompat` via `options.session`
 * to serve clients that send `Mcp-Session-Id` (the pre-2026-06 stateful flow),
 * and a `BackchannelCompat` via `options.backchannel` to let handlers'
 * `ctx.mcpReq.send` (e.g. `elicitInput`, `requestSampling`) reach those
 * clients over the open POST SSE stream.
 */
export function handleHttp(
    mcp: Dispatchable,
    options: ShttpHandlerOptions = {}
): (req: Request, extra?: ShttpRequestExtra) => Promise<Response> {
    return shttpHandler(
        {
            onrequest: (req, env?: RequestEnv) => unwrap(mcp.dispatch(req, env)),
            onnotification: n => mcp.dispatchNotification(n)
        },
        options
    );
}

export { type ShttpHandlerOptions as HandleHttpOptions, type ShttpRequestExtra as HandleHttpRequestExtra } from './shttpHandler.js';
