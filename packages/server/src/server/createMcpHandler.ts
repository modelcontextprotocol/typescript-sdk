/**
 * `createMcpHandler` — the HTTP entry point for serving the 2026-07-28 protocol
 * revision, with old-school stateless 2025-era serving as the default fallback.
 *
 * The entry classifies every inbound HTTP request exactly once (body-primary,
 * via {@linkcode classifyInboundRequest}) and routes it:
 *
 * - Requests carrying the per-request `_meta` envelope are served on the modern
 *   path: a fresh server instance from the consumer's factory, marked as
 *   serving the claimed revision, connected to a single-exchange per-request
 *   transport.
 * - Requests without an envelope claim (including `initialize`, GET/DELETE
 *   session operations, and 2025-era notification POSTs) are legacy traffic.
 *   By default they are served per request through the stateless idiom from
 *   the same factory (`legacy: 'stateless'`); with `legacy: 'reject'` the
 *   endpoint is modern-only strict and answers the documented rejection cells
 *   instead — there is no 2025 serving in that mode.
 *
 * There is no handler-valued `legacy` option: an existing legacy deployment
 * (for example a sessionful streamable HTTP wiring) keeps serving 2025 traffic
 * by routing in user land with {@linkcode isLegacyRequest} — the entry's own
 * classification step, exported as a predicate — in front of a strict
 * (`legacy: 'reject'`) handler.
 *
 * The entry performs no Origin/Host validation (mount the origin/host
 * validation middleware in front of it) and no token verification — `authInfo`
 * is pass-through from the caller and is never derived from request headers.
 */
import type {
    AuthInfo,
    ClientCapabilities,
    Implementation,
    InboundClassificationOutcome,
    InboundLadderRejection,
    InboundLegacyRoute,
    InboundModernRoute,
    RequestId
} from '@modelcontextprotocol/core';
import {
    classifyInboundRequest,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    httpStatusForErrorCode,
    missingClientCapabilities,
    MissingRequiredClientCapabilityError,
    modernOnlyStrictRejection,
    requestMetaOf,
    requiredClientCapabilitiesForRequest,
    scanXMcpHeaderDeclarations,
    SdkError,
    SdkErrorCode,
    setNegotiatedProtocolVersion,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS,
    UnsupportedProtocolVersionError,
    validateMcpParamHeaders,
    validateStandardRequestHeaders
} from '@modelcontextprotocol/core';

import { invoke } from './invoke.js';
import { createListenRouter, DEFAULT_LISTEN_KEEPALIVE_MS, DEFAULT_MAX_SUBSCRIPTIONS } from './listenRouter.js';
import { McpServer } from './mcp.js';
import type { PerRequestResponseMode } from './perRequestTransport.js';
import type { Server } from './server.js';
import { installModernOnlyHandlers, seedClientIdentityFromEnvelope } from './server.js';
import type { ServerEventBus, ServerNotifier } from './serverEventBus.js';
import { createServerNotifier, InMemoryServerEventBus } from './serverEventBus.js';
import { WebStandardStreamableHTTPServerTransport } from './streamableHttp.js';

/* ------------------------------------------------------------------------ *
 * Factory and handler types
 * ------------------------------------------------------------------------ */

/**
 * Construction context handed to an {@linkcode McpServerFactory}.
 *
 * Both serving entries call the factory with this context whenever they need
 * a fresh instance: {@linkcode createMcpHandler} once per HTTP request, and
 * `serveStdio` (from `@modelcontextprotocol/server/stdio`) once per
 * connection — plus once for a `server/discover` probe instance that is
 * discarded again if the client falls back to `initialize`.
 *
 * Zero-argument factories remain assignable unchanged; the context exists for
 * factories that vary by principal or era (for example multi-tenant servers
 * keyed off `authInfo`, or a factory that registers extra surface only for one
 * era).
 */
export interface McpRequestContext {
    /**
     * The protocol era the constructed instance will serve: `modern` for
     * 2026-07-28 (per-request envelope) traffic, `legacy` for 2025-era
     * traffic. Under {@linkcode createMcpHandler} a `legacy` instance serves
     * one request through the stateless legacy fallback (the default —
     * `legacy: 'reject'` endpoints are strict and never construct one); under
     * `serveStdio` it serves a connection that opened with the 2025 handshake
     * and stays pinned to that era for its lifetime.
     */
    era: 'legacy' | 'modern';
    /**
     * Validated authentication information passed by the caller of the
     * handler face (pass-through; HTTP only — `serveStdio` never sets it).
     */
    authInfo?: AuthInfo;
    /** The original HTTP request being served, when available (HTTP only — `serveStdio` never sets it). */
    requestInfo?: Request;
}

/**
 * A factory producing a fresh {@linkcode McpServer} (or low-level
 * {@linkcode Server}) instance for one serving unit: one HTTP request under
 * {@linkcode createMcpHandler}, or one connection (or one discarded
 * `server/discover` probe) under `serveStdio`. The same factory backs every
 * era either entry serves — define your tools, resources and prompts once and
 * serve them to both eras.
 */
export type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

/** Caller-provided per-request inputs for {@linkcode McpHttpHandler.fetch} and fetch-shaped legacy handlers ({@linkcode LegacyHttpHandler}). */
export interface McpHandlerRequestOptions {
    /**
     * Validated authentication information for the request. Strictly
     * pass-through: the handler never populates this from request headers and
     * performs no token verification of its own.
     */
    authInfo?: AuthInfo;
    /** A pre-parsed JSON request body (e.g. `req.body` from `express.json()`). */
    parsedBody?: unknown;
}

/**
 * A fetch-shaped handler serving 2025-era traffic: the shape produced by
 * {@linkcode legacyStatelessFallback}, and the shape a hand-wired composition
 * routes legacy requests to (see {@linkcode isLegacyRequest}). It is not a
 * `legacy` option value — the entry's own legacy serving is selected by the
 * `'stateless' | 'reject'` posture only.
 */
export type LegacyHttpHandler = (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;

/** Options for {@linkcode createMcpHandler}. */
export interface CreateMcpHandlerOptions {
    /**
     * How 2025-era (non-envelope) traffic is served:
     *
     * - `'stateless'` (the default, also when the option is omitted) —
     *   old-school stateless serving: each legacy request is answered by a
     *   fresh instance from the same factory over a streamable HTTP transport
     *   constructed with only `sessionIdGenerator: undefined` (the established
     *   stateless idiom). Because serving is per-request and stateless, GET and
     *   DELETE (2025 session operations) are answered with `405` /
     *   `Method not allowed.`.
     * - `'reject'` — modern-only strict: legacy-classified requests are
     *   rejected with the unsupported-protocol-version error naming the
     *   endpoint's supported revisions (legacy-classified notifications are
     *   acknowledged with `202` and dropped). **There is no 2025 serving in
     *   this mode.**
     *
     * There is no handler-valued option: to keep an existing legacy deployment
     * (for example a sessionful streamable HTTP wiring) serving 2025 traffic
     * next to this entry, route in user land with {@linkcode isLegacyRequest}
     * in front of a `legacy: 'reject'` handler — see that predicate's
     * documentation for the pattern.
     */
    legacy?: 'stateless' | 'reject';
    /** Callback for out-of-band errors and rejected requests (reporting only; it never alters the response). */
    onerror?: (error: Error) => void;
    /**
     * Response shaping for modern (2026-07-28) request exchanges:
     *
     * - `'auto'` (default) — a single JSON body unless the handler emits a
     *   related message before its result, in which case the response upgrades
     *   to an SSE stream.
     * - `'sse'` — always stream.
     * - `'json'` — never stream. **Mid-call notifications (progress, logging,
     *   any related message emitted before the result) are dropped** — only the
     *   terminal result is delivered. Listen-class subscription streams are
     *   always served over SSE regardless of this setting.
     */
    responseMode?: PerRequestResponseMode;
    /**
     * The change-event bus `subscriptions/listen` streams subscribe to.
     *
     * When omitted, an in-process {@link InMemoryServerEventBus} is created
     * and the returned handler's `notify` sugar publishes onto it.
     * Multi-process deployments supply their own implementation over their
     * pub/sub backend; the same instance can be shared across handlers.
     */
    bus?: ServerEventBus;
    /**
     * Reject a new `subscriptions/listen` with `-32603` 'Subscription limit
     * reached' (in-band, HTTP 200, before the ack) when this many subscription
     * streams are already open on this handler.
     * @default 1024
     */
    maxSubscriptions?: number;
    /**
     * SSE comment-frame keepalive interval for `subscriptions/listen` streams,
     * in milliseconds. Set to `0` to disable.
     * @default 15000
     */
    keepAliveMs?: number;
}

/**
 * The handler returned by {@linkcode createMcpHandler}: a web-standard
 * `{ fetch, close, notify, bus }` object — the shape Workers/Bun/Deno expect
 * from `export default`. `fetch` is an arrow-assigned bound property: it can be
 * detached and passed around (`const { fetch } = handler`) without losing its
 * binding.
 *
 * Node frameworks (Express, Fastify, plain `node:http`) wrap the handler once
 * with `toNodeHandler(handler)` from `@modelcontextprotocol/node`.
 */
export interface McpHttpHandler {
    /** Web-standard face: serve one HTTP request and resolve with the response. */
    fetch: (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;
    /**
     * Tears down the modern leg: aborts in-flight modern exchanges and closes
     * their per-request instances. Legacy serving is unaffected — the
     * stateless fallback is per-request by construction and holds nothing
     * between exchanges.
     */
    close: () => Promise<void>;
    /**
     * Typed publish-side facade over the handler's `subscriptions/listen` bus:
     * each method publishes the corresponding change event to every open
     * subscription stream that opted in to that notification type.
     *
     * Safe to call when no subscription is open (no-op).
     */
    notify: ServerNotifier;
    /**
     * The change-event bus this handler's `subscriptions/listen` streams
     * subscribe to (the supplied `bus` option, or the auto-created in-process
     * default).
     */
    bus: ServerEventBus;
}

/* ------------------------------------------------------------------------ *
 * Shared response helpers
 * ------------------------------------------------------------------------ */

/**
 * The JSON-RPC id to echo on an entry-built error response: the body's `id`
 * when the body is a single JSON-RPC request whose id is a string or number,
 * `null` otherwise. Error responses must carry the id of the request they
 * correspond to whenever it could be read; `null` is reserved for the cases
 * where no single request id is determinable — unparseable bodies, body-less
 * methods, notifications, posted responses and batch arrays.
 */
function echoableRequestId(body: unknown): RequestId | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const { method, id } = body as { method?: unknown; id?: unknown };
    if (typeof method !== 'string') {
        return null;
    }
    return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function jsonRpcErrorResponse(httpStatus: number, code: number, message: string, data?: unknown, id: RequestId | null = null): Response {
    return Response.json(
        {
            jsonrpc: '2.0',
            error: { code, message, ...(data !== undefined && { data }) },
            id
        },
        { status: httpStatus }
    );
}

function rejectionResponse(rejection: InboundLadderRejection, id: RequestId | null = null): Response {
    return jsonRpcErrorResponse(rejection.httpStatus, rejection.code, rejection.message, rejection.data, id);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function internalServerErrorResponse(id: RequestId | null = null): Response {
    return jsonRpcErrorResponse(500, -32_603, 'Internal server error', undefined, id);
}

/* ------------------------------------------------------------------------ *
 * The default legacy fallback
 * ------------------------------------------------------------------------ */

/**
 * The entry's default legacy serving (`legacy: 'stateless'`): per-request
 * stateless serving of 2025-era traffic using the same factory as the modern
 * path. Exported as a standalone building block for hand-wired compositions
 * (for example mounting legacy stateless serving on its own route next to a
 * strict modern endpoint).
 *
 * Each POST is served by a fresh instance from the factory connected to a
 * fresh streamable HTTP transport constructed with only
 * `sessionIdGenerator: undefined` — the established stateless idiom, unchanged.
 * Because serving is per-request and stateless, GET and DELETE (2025 session
 * operations) are answered with `405` / `Method not allowed.`, exactly like the
 * canonical stateless example.
 *
 * The optional `onerror` callback receives factory and serving failures on
 * this leg (reporting only — the response stays the 500 internal-error body).
 * The entry passes its own `onerror` here when expanding the default, so
 * legacy-leg failures are never silently swallowed.
 */
export function legacyStatelessFallback(factory: McpServerFactory, onerror?: (error: Error) => void): LegacyHttpHandler {
    return async (request, options) => {
        if (request.method.toUpperCase() !== 'POST') {
            return jsonRpcErrorResponse(405, -32_000, 'Method not allowed.');
        }
        try {
            const product = await factory({
                era: 'legacy',
                ...(options?.authInfo !== undefined && { authInfo: options.authInfo }),
                requestInfo: request
            });
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await product.connect(transport);

            const teardown = () => {
                void transport.close().catch(() => {});
                void product.close().catch(() => {});
            };
            // Tear the per-request pair down when the client goes away before
            // the exchange completes.
            request.signal?.addEventListener('abort', teardown, { once: true });

            const response = await transport.handleRequest(request, {
                ...(options?.authInfo !== undefined && { authInfo: options.authInfo }),
                ...(options?.parsedBody !== undefined && { parsedBody: options.parsedBody })
            });
            if (response.body === null || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
                // Non-streaming exchange (a buffered JSON body or a body-less
                // ack): the response is complete, release the pair now.
                teardown();
                return response;
            }
            // Streaming exchange: the legacy transport answers request-bearing
            // POSTs over SSE, so the exchange is only over once the stream has
            // been fully delivered. Wrap the body so the pair is torn down on
            // completion, on a producer error, or when the consumer abandons
            // the stream — the fetch-world analog of the canonical stateless
            // example's close-on-response-end.
            const reader = response.body.getReader();
            let toreDown = false;
            const completeExchange = () => {
                if (!toreDown) {
                    toreDown = true;
                    teardown();
                }
            };
            const monitoredBody = new ReadableStream<Uint8Array>({
                pull: async controller => {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            completeExchange();
                            controller.close();
                            return;
                        }
                        if (value !== undefined) {
                            controller.enqueue(value);
                        }
                    } catch (error) {
                        completeExchange();
                        controller.error(error);
                    }
                },
                cancel: reason => {
                    completeExchange();
                    return reader.cancel(reason).catch(() => {});
                }
            });
            return new Response(monitoredBody, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        } catch (error) {
            try {
                onerror?.(toError(error));
            } catch {
                // Reporting must never alter the response.
            }
            return internalServerErrorResponse(echoableRequestId(options?.parsedBody));
        }
    };
}

/* ------------------------------------------------------------------------ *
 * The entry's classification step (shared with isLegacyRequest)
 * ------------------------------------------------------------------------ */

/** The outcome of the entry's classification step for one inbound HTTP request. */
type EntryClassification =
    /** The body bytes could not be read at all (a failing stream, not malformed JSON). */
    | { step: 'unreadable-body' }
    /** A POST with an empty or non-JSON body: nothing to classify, so there is no envelope claim. */
    | { step: 'no-json-body'; forwardRequest: Request }
    /** A classifiable request, with the classifier's routing outcome. */
    | { step: 'classified'; outcome: InboundClassificationOutcome; body: unknown; parsedBody: unknown; forwardRequest: Request };

/**
 * The entry's classification step: read the request body exactly once (unless
 * a pre-parsed body is supplied) and classify the request with
 * {@linkcode classifyInboundRequest}. This is the single code path behind both
 * {@linkcode createMcpHandler}'s routing and the exported
 * {@linkcode isLegacyRequest} predicate, so the two can never disagree.
 *
 * Pass `needsForward: false` when the caller never reads `forwardRequest` —
 * the body-preserving clone is then skipped and `forwardRequest` is the
 * (consumed) input request.
 */
async function classifyEntryRequest(request: Request, providedParsedBody?: unknown, needsForward = true): Promise<EntryClassification> {
    const httpMethod = request.method.toUpperCase();

    let body: unknown;
    let parsedBody = providedParsedBody;
    let forwardRequest = request;
    let unparseable = false;

    if (httpMethod === 'POST') {
        if (parsedBody === undefined) {
            // Read the body exactly once for classification, keeping an unread
            // copy of the original bytes for the legacy leg (web-standard
            // request bodies are single-use) when the caller needs it.
            if (needsForward) {
                forwardRequest = request.clone();
            }
            let bodyText: string;
            try {
                bodyText = await request.text();
            } catch {
                return { step: 'unreadable-body' };
            }
            try {
                body = bodyText.length === 0 ? undefined : JSON.parse(bodyText);
            } catch {
                unparseable = true;
            }
            if (!unparseable && body !== undefined) {
                parsedBody = body;
            }
        } else {
            body = parsedBody;
        }

        if (unparseable || body === undefined) {
            return { step: 'no-json-body', forwardRequest };
        }
    }

    const outcome = classifyInboundRequest({
        httpMethod,
        protocolVersionHeader: request.headers.get('mcp-protocol-version') ?? undefined,
        mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
        mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
        ...(body !== undefined && { body })
    });
    return { step: 'classified', outcome, body, parsedBody, forwardRequest };
}

/**
 * Whether {@linkcode createMcpHandler} would route this request to its legacy
 * (2025-era) serving rather than the modern (2026-07-28) path.
 *
 * This is the entry's own classification step exported as a predicate — it
 * runs exactly the code `createMcpHandler` runs to make the routing decision,
 * not a re-implementation — so a hand-wired composition that branches on it
 * can never disagree with the entry. Use it to keep an existing legacy
 * deployment (for example a sessionful streamable HTTP wiring) serving 2025
 * traffic next to a strict modern endpoint, now that the entry has no
 * handler-valued `legacy` option:
 *
 * ```ts
 * import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
 *
 * const modern = createMcpHandler(factory, { legacy: 'reject' });
 *
 * export default {
 *     async fetch(request: Request): Promise<Response> {
 *         if (await isLegacyRequest(request)) {
 *             // e.g. an existing sessionful WebStandardStreamableHTTPServerTransport wiring
 *             return myExistingLegacyHandler(request);
 *         }
 *         return modern.fetch(request);
 *     }
 * };
 * ```
 *
 * Semantics (identical to the entry's routing):
 *
 * - Returns `true` only for requests with no per-request `_meta` envelope
 *   claim: claim-less POSTs (including the `initialize` handshake and 2025-era
 *   notification POSTs without a modern protocol-version header), body-less
 *   GET/DELETE session operations, all-legacy JSON-RPC batch arrays, posted
 *   JSON-RPC responses, and POSTs whose body is empty or not valid JSON.
 * - Returns `false` for everything the modern path answers, including its
 *   validation-ladder rejections: a request carrying the envelope claim (even
 *   one naming a revision the endpoint does not serve — the modern path
 *   answers it with the unsupported-protocol-version error), a malformed
 *   envelope behind a present claim (answered `-32602`), a request whose
 *   `MCP-Protocol-Version` header names a modern revision but that lacks the
 *   envelope (`-32602`), and header/body mismatches (`-32020`). Consumers
 *   routing on the predicate must send `false` traffic to the modern handler,
 *   never to a legacy handler — the modern path owns those error answers.
 * - `server/discover` probes sent by negotiating clients always carry the
 *   envelope claim, so they are never legacy; a hand-built claim-less POST to
 *   a method named `server/discover` has no claim and classifies legacy,
 *   exactly as the entry itself routes it.
 *
 * The body is read from a clone, so the passed request stays readable for
 * whichever handler the caller routes it to. If the body has already been
 * consumed (for example behind `express.json()`), pass the parsed body as the
 * second argument and no body read happens at all — without it the predicate
 * cannot classify a consumed POST body (cloning a used body throws a
 * `TypeError`), so the call rejects instead of guessing.
 */
export async function isLegacyRequest(request: Request, parsedBody?: unknown): Promise<boolean> {
    // Classify a clone so the caller's request body stays readable; with a
    // pre-parsed body (or a body-less method) nothing is read and no clone is
    // needed. The predicate never reads forwardRequest, so the classification
    // step's own forwarding clone is skipped.
    const probe = parsedBody === undefined && request.method.toUpperCase() === 'POST' ? request.clone() : request;
    const classified = await classifyEntryRequest(probe, parsedBody, false);
    return classified.step === 'no-json-body' || (classified.step === 'classified' && classified.outcome.kind === 'legacy');
}

/* ------------------------------------------------------------------------ *
 * The entry
 * ------------------------------------------------------------------------ */

/**
 * Creates an HTTP handler that serves the 2026-07-28 protocol revision from a
 * per-request server factory and, by default, falls back to old-school
 * stateless serving for 2025-era traffic. Pass `legacy: 'reject'` for a
 * modern-only strict endpoint.
 *
 * Mounting: `handler.fetch` is the web-standard face (Cloudflare Workers,
 * Deno, Bun, Hono's `c.req.raw`); for Express/Fastify/plain `node:http`, wrap
 * the handler once with `toNodeHandler(handler)` from
 * `@modelcontextprotocol/node`. When mounting bare on a fetch-native runtime,
 * put Origin/Host validation in front of the handler — the entry itself is
 * deliberately validation-free:
 *
 * ```ts
 * import { hostHeaderValidationResponse, originValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins } from '@modelcontextprotocol/server';
 *
 * export default {
 *     async fetch(request: Request): Promise<Response> {
 *         const rejected =
 *             hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
 *             originValidationResponse(request, localhostAllowedOrigins());
 *         return rejected ?? handler.fetch(request);
 *     }
 * };
 * ```
 *
 * Use ONE factory for both legs: the same tools/resources/prompts definition
 * backs the modern path and the stateless legacy fallback, so the two eras can
 * never drift apart. To keep an existing legacy deployment (for example a
 * sessionful streamable HTTP wiring) serving 2025 traffic instead of the
 * stateless fallback, route in user land with {@linkcode isLegacyRequest} in
 * front of a strict handler — see that predicate's documentation for the
 * pattern. Power users composing transport-neutral routing can also use the
 * exported building blocks directly: {@linkcode classifyInboundRequest} for
 * the era decision and `PerRequestHTTPServerTransport` for single-exchange
 * serving.
 *
 * The entry performs no token verification: `authInfo` given to `fetch` is
 * passed through to handlers and the factory as-is and is never derived from
 * request headers.
 */
export function createMcpHandler(factory: McpServerFactory, options: CreateMcpHandlerOptions = {}): McpHttpHandler {
    const { legacy, onerror, responseMode } = options;

    // Construction-time guard for JavaScript callers passing a handler as the
    // legacy value: the option only selects a posture ('stateless' | 'reject').
    // Failing loudly here beats silently treating the handler as the default.
    if (typeof legacy === 'function') {
        throw new TypeError(
            "The 'legacy' option only accepts 'stateless' or 'reject', not a handler function. To serve 2025-era traffic with your own " +
                "handler, route in user land with the exported isLegacyRequest(request) predicate in front of a strict (legacy: 'reject') handler."
        );
    }

    /** Modern per-request instances with an exchange still in flight (close() tears these down). */
    const inflight = new Set<Server>();
    let closed = false;

    const reportError = (error: Error) => {
        try {
            onerror?.(error);
        } catch {
            // Reporting must never alter the response.
        }
    };

    const bus: ServerEventBus = options.bus ?? new InMemoryServerEventBus(reportError);
    const notify = createServerNotifier(bus);
    const listenRouter = createListenRouter({
        bus,
        maxSubscriptions: options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
        keepAliveMs: options.keepAliveMs ?? DEFAULT_LISTEN_KEEPALIVE_MS,
        onerror: reportError
    });
    if (responseMode === 'json') {
        // eslint-disable-next-line no-console
        console.warn(
            "responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; " +
                'other notifications emitted before a result are dropped.'
        );
    }

    // The default posture is the stateless fallback; 'reject' is the only way
    // to turn legacy serving off (modern-only strict).
    const legacyHandler: LegacyHttpHandler | undefined = legacy === 'reject' ? undefined : legacyStatelessFallback(factory, reportError);

    async function serveModern(route: InboundModernRoute, request: Request, authInfo: AuthInfo | undefined): Promise<Response> {
        const claimedRevision = route.classification.revision;
        if (claimedRevision === undefined || !SUPPORTED_MODERN_PROTOCOL_VERSIONS.includes(claimedRevision)) {
            // The claim names a revision this endpoint does not serve (an
            // unknown future revision, or a 2025-era revision delivered via the
            // envelope mechanism).
            const error = new UnsupportedProtocolVersionError({
                supported: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
                requested: claimedRevision ?? 'unknown'
            });
            reportError(error);
            return jsonRpcErrorResponse(400, error.code, error.message, error.data, echoableRequestId(route.message));
        }

        // SEP-2243 standard-header presence and `Mcp-Name` cross-check
        // (`standard-header-validation` rung; the `MCP-Protocol-Version` and
        // `Mcp-Method` *mismatch* cells are already answered inside
        // `classifyInboundRequest` on the edge `era-classification` rung).
        // Evaluated after the supported-revision
        // gate so an envelope naming a revision this endpoint does not serve
        // is still answered with `-32022` (the supported list is the more
        // useful answer to a client speaking the wrong revision); evaluated
        // before the capability gate, the factory call, and the
        // `Mcp-Param-*` rung so a request that fails several rungs is
        // answered by the standard-header rung first.
        const stdHeaderRejection = validateStandardRequestHeaders(
            {
                httpMethod: request.method,
                mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
                mcpNameHeader: request.headers.get('mcp-name') ?? undefined
            },
            route
        );
        if (stdHeaderRejection !== undefined) {
            reportError(new Error(`Rejected inbound request (${stdHeaderRejection.cell}): ${stdHeaderRejection.message}`));
            return rejectionResponse(stdHeaderRejection, echoableRequestId(route.message));
        }

        const meta = route.messageKind === 'request' ? requestMetaOf(route.message.params) : undefined;
        const declaredClientCapabilities = meta?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;

        // Pre-dispatch capability gate: a request to a method whose processing
        // structurally requires a client capability the request's validated
        // envelope did not declare is refused here, before any instance is
        // constructed or dispatched. Answering at the entry pins the
        // spec-mandated HTTP 400 for this error; a handler-time emission would
        // surface in-band on HTTP 200.
        if (route.messageKind === 'request') {
            const required = requiredClientCapabilitiesForRequest(route.message.method);
            if (required !== undefined) {
                const missing = missingClientCapabilities(required, declaredClientCapabilities);
                if (missing !== undefined) {
                    const error = new MissingRequiredClientCapabilityError({ requiredCapabilities: missing });
                    reportError(error);
                    return jsonRpcErrorResponse(
                        httpStatusForErrorCode(error.code, 'ladder'),
                        error.code,
                        error.message,
                        error.data,
                        route.message.id
                    );
                }
            }
        }

        const product = await factory({
            era: 'modern',
            ...(authInfo !== undefined && { authInfo }),
            requestInfo: request
        });
        const server = product instanceof McpServer ? product.server : product;

        // Entry-handled `subscriptions/listen`: the router owns ack-first /
        // per-stream filtering / subscription-id stamping / keepalive /
        // capacity / teardown. The factory IS constructed for listen — to read
        // the instance's declared capabilities only, so the acknowledged
        // filter reflects what the server can actually deliver. Unlike the
        // discover path (which connects via the per-request transport and tears
        // down with it), the probe instance is never connected: capabilities
        // are read off the unconnected instance and it is closed immediately.
        // Authorization the consumer performs inside the factory therefore DOES
        // see listen requests, although token verification still belongs at the
        // middleware layer mounted in front of this entry.
        if (route.messageKind === 'request' && route.message.method === 'subscriptions/listen') {
            const capabilities = server.getCapabilities();
            void product.close().catch(reportError);
            return listenRouter.serve(route.message, request.signal, capabilities);
        }

        // SEP-2243 `Mcp-Param-*` server-side validation (pre-dispatch ladder
        // rung): for a `tools/call`, look up the named tool's JSON inputSchema
        // on the just-produced instance and compare every `x-mcp-header`
        // declaration against the request's `Mcp-Param-{Name}` headers and the
        // body `arguments`. A mismatch (or a missing header for a present body
        // value, or an invalid Base64 sentinel) emits the same `400` /
        // `-32020` (`HeaderMismatch`) shape the edge cross-checks use. Only
        // applied when the factory returns an `McpServer` (the registry is the
        // schema source); a low-level `Server` factory has no registry, so
        // there is nothing to validate against.
        if (route.messageKind === 'request' && route.message.method === 'tools/call' && product instanceof McpServer) {
            const callParams = route.message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
            const toolName = typeof callParams?.name === 'string' ? callParams.name : undefined;
            const inputSchema = toolName === undefined ? undefined : product.toolInputSchemaJson(toolName);
            if (inputSchema !== undefined) {
                const scan = scanXMcpHeaderDeclarations(inputSchema);
                if (scan.valid && scan.declarations.length > 0) {
                    const rejection = validateMcpParamHeaders(scan.declarations, callParams?.arguments, request.headers);
                    if (rejection !== undefined) {
                        void product.close().catch(reportError);
                        reportError(new Error(`Rejected inbound request (${rejection.cell}): ${rejection.message}`));
                        return rejectionResponse(rejection, route.message.id);
                    }
                }
            }
        }

        // Era-write at instance binding, then modern-only handler installation —
        // both before the instance is connected to the per-request transport.
        setNegotiatedProtocolVersion(server, claimedRevision);
        installModernOnlyHandlers(server, SUPPORTED_MODERN_PROTOCOL_VERSIONS);

        if (meta !== undefined) {
            seedClientIdentityFromEnvelope(server, {
                clientInfo: meta[CLIENT_INFO_META_KEY] as Implementation | undefined,
                clientCapabilities: declaredClientCapabilities
            });
        }

        // Track the instance until its exchange tears down so close() can abort it.
        const previousOnClose = server.onclose;
        inflight.add(server);
        server.onclose = () => {
            inflight.delete(server);
            previousOnClose?.();
        };

        try {
            const response = await invoke(product, route.message, {
                classification: route.classification,
                request,
                ...(authInfo !== undefined && { authInfo }),
                ...(responseMode !== undefined && { responseMode })
            });
            if (route.messageKind === 'notification') {
                // Notification exchanges have no terminal response to ride the
                // transport's auto-close, so release the per-request instance here.
                queueMicrotask(() => void server.close().catch(() => {}));
            }
            return response;
        } catch (error) {
            if (error instanceof SdkError && error.code === SdkErrorCode.ConnectionClosed) {
                // The client went away before a response existed; there is
                // nobody left to answer.
                return new Response(null, { status: 499 });
            }
            // No terminal response will ride the transport's close chain after a
            // failure here: close the per-request instance explicitly and drop it
            // from the in-flight set so repeated failures cannot accumulate
            // connected instances until handler.close().
            await server.close().catch(() => {});
            inflight.delete(server);
            reportError(toError(error));
            return internalServerErrorResponse(echoableRequestId(route.message));
        }
    }

    async function serveLegacyRoute(
        route: InboundLegacyRoute,
        forwardRequest: Request,
        authInfo: AuthInfo | undefined,
        parsedBody: unknown
    ): Promise<Response> {
        if (legacyHandler !== undefined) {
            return legacyHandler(forwardRequest, {
                ...(authInfo !== undefined && { authInfo }),
                ...(parsedBody !== undefined && { parsedBody })
            });
        }
        const strict = modernOnlyStrictRejection(route, SUPPORTED_MODERN_PROTOCOL_VERSIONS);
        if (strict === undefined) {
            // Legacy-classified notification on a modern-only endpoint:
            // acknowledged and dropped, never dispatched.
            return new Response(null, { status: 202 });
        }
        reportError(new Error(`Rejected 2025-era request on a modern-only endpoint (${strict.cell}): ${strict.message}`));
        return rejectionResponse(strict, echoableRequestId(parsedBody));
    }

    async function handle(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
        const authInfo = requestOptions?.authInfo;
        const classified = await classifyEntryRequest(request, requestOptions?.parsedBody);

        if (classified.step === 'unreadable-body') {
            return jsonRpcErrorResponse(400, -32_700, 'Parse error: the request body could not be read');
        }
        if (classified.step === 'no-json-body') {
            // No JSON body to classify: there is no envelope claim, so this is
            // legacy traffic when legacy serving is configured (the legacy leg
            // answers its own parse error, unchanged), and a parse error
            // otherwise.
            if (legacyHandler !== undefined) {
                return legacyHandler(classified.forwardRequest, { ...(authInfo !== undefined && { authInfo }) });
            }
            return jsonRpcErrorResponse(400, -32_700, 'Parse error: the request body is not valid JSON');
        }

        const { outcome, body, parsedBody, forwardRequest } = classified;
        try {
            switch (outcome.kind) {
                case 'reject': {
                    reportError(new Error(`Rejected inbound request (${outcome.cell}): ${outcome.message}`));
                    return rejectionResponse(outcome, echoableRequestId(body));
                }
                case 'modern': {
                    return await serveModern(outcome, request, authInfo);
                }
                case 'legacy': {
                    return await serveLegacyRoute(outcome, forwardRequest, authInfo, parsedBody);
                }
            }
        } catch (error) {
            // Entry-internal failure while serving a classified request (a
            // throwing factory or a failed connect, on either leg): the parsed
            // body is in scope here, so the 500 body echoes the request id when
            // it could be read.
            reportError(toError(error));
            return internalServerErrorResponse(echoableRequestId(body));
        }
    }

    const fetchFace = async (request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> => {
        if (closed) {
            throw new Error('This MCP handler has been closed');
        }
        try {
            return await handle(request, requestOptions);
        } catch (error) {
            reportError(toError(error));
            return internalServerErrorResponse(echoableRequestId(requestOptions?.parsedBody));
        }
    };

    return {
        fetch: fetchFace,
        notify,
        bus,
        close: async () => {
            closed = true;
            listenRouter.closeAll();
            const closing = [...inflight].map(server => server.close().catch(() => {}));
            inflight.clear();
            await Promise.all(closing);
        }
    };
}
