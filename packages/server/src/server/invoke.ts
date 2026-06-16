/**
 * The internal per-request invoke seam for modern-era HTTP serving.
 *
 * One classified inbound message is served by composing existing pieces, with
 * no changes to the protocol dispatch layer:
 *
 *   server instance (from the consumer's factory)
 *     → `connect(per-request transport)`
 *     → inject the classified message through the transport's message callback
 *     → capture the value (a single JSON body or an SSE stream) via the
 *       transport's send path.
 *
 * The seam is value-returning and independently testable: it resolves with the
 * HTTP `Response` for the exchange. Marking factory instances as modern-era
 * (and installing modern-only handlers) is the calling entry's responsibility
 * and happens before this seam runs; the seam itself never writes era state.
 */
import type { AuthInfo, JSONRPCNotification, JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core';

import type { McpServer } from './mcp.js';
import type { PerRequestResponseMode } from './perRequestTransport.js';
import { PerRequestHTTPServerTransport } from './perRequestTransport.js';
import type { Server } from './server.js';

/** Per-exchange context for {@linkcode invoke}. */
export interface InvokeContext {
    /** The edge classification of the message (computed once, at the entry boundary). */
    classification: MessageClassification;
    /** The original HTTP request, when serving HTTP traffic. */
    request?: globalThis.Request;
    /**
     * Validated authentication information supplied by the caller. Strictly
     * pass-through — never derived from request headers by this seam.
     */
    authInfo?: AuthInfo;
    /** Response shaping for the exchange; defaults to `auto` (lazy SSE upgrade). */
    responseMode?: PerRequestResponseMode;
}

/**
 * Serves one classified inbound message on the given server instance and
 * returns the HTTP response for the exchange.
 *
 * The instance is connected to a fresh single-exchange transport, the message
 * is injected through the normal transport message path, and whatever the
 * dispatch layer produces (the handler result, a protocol-level rejection, or
 * streamed related messages followed by the result) is captured as the
 * returned `Response`. For request exchanges, teardown rides the transport's
 * close chain once the terminal response has been delivered; notification
 * exchanges resolve with the 202 response immediately and do NOT run the
 * close chain — the transport stays connected until the caller closes it or
 * drops the per-request instance, which is the caller's choice either way.
 */
export async function invoke(
    server: Server | McpServer,
    message: JSONRPCRequest | JSONRPCNotification,
    ctx: InvokeContext
): Promise<Response> {
    const transport = new PerRequestHTTPServerTransport({
        classification: ctx.classification,
        ...(ctx.responseMode !== undefined && { responseMode: ctx.responseMode })
    });
    await server.connect(transport);
    return transport.handleMessage(message, {
        ...(ctx.request !== undefined && { request: ctx.request }),
        ...(ctx.authInfo !== undefined && { authInfo: ctx.authInfo })
    });
}
