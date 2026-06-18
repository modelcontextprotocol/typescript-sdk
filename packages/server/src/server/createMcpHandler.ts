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
    JSONRPCNotification,
    JSONRPCRequest,
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
    SdkError,
    SdkErrorCode,
    setNegotiatedProtocolVersion,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS,
    UnsupportedProtocolVersionError
} from '@modelcontextprotocol/core';

import { invoke } from './invoke.js';
import { createListenRouter, DEFAULT_LISTEN_KEEPALIVE_MS, DEFAULT_MAX_SUBSCRIPTIONS } from './listenRouter.js';
import { McpServer } from './mcp.js';
import type { PerRequestResponseMode } from './perRequestTransport.js';
import type { Server } from './server.js';
import { installModernOnlyHandlers, seedClientIdentityFromEnvelope } from './server.js';
import type { ServerEventBus, ServerNotifySugar } from './serverEventBus.js';
import { createNotifySugar, InMemoryServerEventBus } from './serverEventBus.js';
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
 * Minimal duck-typed shape of a Node.js `IncomingMessage` accepted by
 * {@linkcode McpHttpHandler.node}. Kept structural so the handler stays free of
 * `node:` imports and bundles for non-Node runtimes.
 */
export interface NodeIncomingMessageLike extends AsyncIterable<unknown> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    /** Validated authentication info attached by upstream middleware (pass-through). */
    auth?: AuthInfo;
}

/** Minimal duck-typed shape of a Node.js `ServerResponse` accepted by {@linkcode McpHttpHandler.node}. */
export interface NodeServerResponseLike {
    writeHead(statusCode: number, headers?: Record<string, string>): unknown;
    write(chunk: string | Uint8Array): unknown;
    end(chunk?: string | Uint8Array): unknown;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The handler returned by {@linkcode createMcpHandler}. Both faces are
 * arrow-assigned bound properties: they can be detached and passed around
 * (`const { fetch } = handler`) without losing their binding.
 */
export interface McpHttpHandler {
    /** Web-standard face: serve one HTTP request and resolve with the response. */
    fetch: (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;
    /**
     * Node face: serve one Node.js request/response pair. The third argument is
     * an optional pre-parsed body (`req.body` from `express.json()`); a function
     * third argument (Express's `next` when the handler is mounted as
     * middleware) is ignored.
     */
    node: (req: NodeIncomingMessageLike, res: NodeServerResponseLike, parsedBody?: unknown) => Promise<void>;
    /**
     * Tears down the modern leg: aborts in-flight modern exchanges and closes
     * their per-request instances. Legacy serving is unaffected — the
     * stateless fallback is per-request by construction and holds nothing
     * between exchanges.
     */
    close: () => Promise<void>;
    /**
     * Typed publish-side sugar over the handler's `subscriptions/listen` bus:
     * each method publishes the corresponding change event to every open
     * subscription stream that opted in to that notification type.
     *
     * Safe to call when no subscription is open (no-op).
     */
    notify: ServerNotifySugar;
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
 */
async function classifyEntryRequest(request: Request, providedParsedBody?: unknown): Promise<EntryClassification> {
    const httpMethod = request.method.toUpperCase();

    let body: unknown;
    let parsedBody = providedParsedBody;
    let forwardRequest = request;
    let unparseable = false;

    if (httpMethod === 'POST') {
        if (parsedBody === undefined) {
            // Read the body exactly once for classification, keeping an unread
            // copy of the original bytes for the legacy leg (web-standard
            // request bodies are single-use).
            forwardRequest = request.clone();
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
 *   envelope (`-32602`), and header/body mismatches (`-32001`). Consumers
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
    // needed.
    const probe = parsedBody === undefined && request.method.toUpperCase() === 'POST' ? request.clone() : request;
    const classified = await classifyEntryRequest(probe, parsedBody);
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
 * Deno, Bun, Hono's `c.req.raw`); `handler.node(req, res, req.body)` is the
 * Node face for Express/Fastify/plain `node:http`. When mounting bare on a
 * fetch-native runtime, put Origin/Host validation in front of the handler —
 * the entry itself is deliberately validation-free:
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
 * The entry performs no token verification: `authInfo` given to the faces is
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
    const notify = createNotifySugar(bus);
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

    async function serveModern(
        route: InboundModernRoute,
        message: JSONRPCRequest | JSONRPCNotification,
        request: Request,
        authInfo: AuthInfo | undefined
    ): Promise<Response> {
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
            return jsonRpcErrorResponse(400, error.code, error.message, error.data, echoableRequestId(message));
        }

        const meta = route.messageKind === 'request' ? requestMetaOf((message as JSONRPCRequest).params) : undefined;
        const declaredClientCapabilities = meta?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;

        // Pre-dispatch capability gate: a request to a method whose processing
        // structurally requires a client capability the request's validated
        // envelope did not declare is refused here, before any instance is
        // constructed or dispatched. Answering at the entry pins the
        // spec-mandated HTTP 400 for this error; a handler-time emission would
        // surface in-band on HTTP 200.
        if (route.messageKind === 'request') {
            const required = requiredClientCapabilitiesForRequest((message as JSONRPCRequest).method);
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
                        (message as JSONRPCRequest).id
                    );
                }
            }
        }

        // Entry-handled `subscriptions/listen`: recognized BEFORE the factory
        // is consulted. The router owns ack-first / per-stream filtering /
        // subscription-id stamping / keepalive / capacity / teardown; the
        // factory is not constructed for listen, so any authorization the
        // consumer performs inside the factory does not see listen requests
        // (token verification belongs at the middleware layer mounted in
        // front of this entry — the entry's documented authz posture).
        if (route.messageKind === 'request' && (message as JSONRPCRequest).method === 'subscriptions/listen') {
            return listenRouter.serve(message as JSONRPCRequest, request.signal);
        }

        const product = await factory({
            era: 'modern',
            ...(authInfo !== undefined && { authInfo }),
            requestInfo: request
        });
        const server = product instanceof McpServer ? product.server : product;

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
            const response = await invoke(product, message, {
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
            return internalServerErrorResponse(echoableRequestId(message));
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
                    return await serveModern(outcome, body as JSONRPCRequest | JSONRPCNotification, request, authInfo);
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

    const nodeFace = async (req: NodeIncomingMessageLike, res: NodeServerResponseLike, parsedBody?: unknown): Promise<void> => {
        // Express passes (req, res, next) when the handler is mounted as a
        // middleware function; a function third argument is `next`, not a body.
        if (typeof parsedBody === 'function') {
            parsedBody = undefined;
        }

        let finished = false;
        const abort = new AbortController();
        res.on('close', () => {
            if (!finished) {
                abort.abort();
            }
        });

        let response: Response;
        try {
            const request = await nodeRequestToFetchRequest(req, parsedBody, abort.signal);
            response = await fetchFace(request, {
                ...(req.auth !== undefined && { authInfo: req.auth }),
                ...(parsedBody !== undefined && { parsedBody })
            });
        } catch (error) {
            reportError(toError(error));
            response = internalServerErrorResponse(echoableRequestId(parsedBody));
        }

        const headers: Record<string, string> = {};
        for (const [name, value] of response.headers) {
            headers[name] = value;
        }
        res.writeHead(response.status, headers);
        if (response.body === null) {
            finished = true;
            res.end();
            return;
        }
        const reader = response.body.getReader();
        // Honor write backpressure: when write() reports a full buffer (Node's
        // `false` return), wait for the response to drain before pulling the
        // next chunk. A single listener resolves whichever wait is pending; a
        // closed response also releases the wait so a vanished client cannot
        // park the loop forever.
        let drainResolve: (() => void) | undefined;
        const releaseDrainWait = () => {
            drainResolve?.();
            drainResolve = undefined;
        };
        res.on('drain', releaseDrainWait);
        res.on('close', releaseDrainWait);
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (value !== undefined && res.write(value) === false) {
                    await new Promise<void>(resolve => {
                        drainResolve = resolve;
                    });
                }
            }
        } catch {
            // The client went away while streaming; the abort signal already
            // cancelled the exchange.
        }
        finished = true;
        res.end();
    };

    return {
        fetch: fetchFace,
        node: nodeFace,
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

/* ------------------------------------------------------------------------ *
 * Node request conversion (duck-typed; no node: imports)
 * ------------------------------------------------------------------------ */

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

async function nodeRequestToFetchRequest(req: NodeIncomingMessageLike, parsedBody: unknown, signal: AbortSignal): Promise<Request> {
    const method = (req.method ?? 'GET').toUpperCase();
    const host = singleHeaderValue(req.headers['host']) ?? 'localhost';
    const url = `http://${host}${req.url ?? '/'}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        // HTTP/2 pseudo-headers (`:method`, `:path`, `:authority`, …) are
        // connection metadata, not header fields — `Headers` rejects their
        // names, so they are skipped rather than copied.
        if (value === undefined || name.startsWith(':')) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(name, item);
            }
        } else {
            headers.set(name, value);
        }
    }

    // The body is carried as text: MCP request bodies are JSON, and a string
    // body keeps the constructed Request portable across runtime lib versions.
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
        if (parsedBody === undefined) {
            const decoder = new TextDecoder();
            let collected = '';
            for await (const chunk of req) {
                collected += typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
            }
            collected += decoder.decode();
            if (collected.length > 0) {
                body = collected;
            }
        } else {
            // The caller already consumed and parsed the Node stream (the
            // documented `handler.node(req, res, req.body)` mounting behind
            // `express.json()`), so the bytes cannot be re-read. Re-serialize
            // the parsed value so consumers of the forwarded Request — anything
            // on the legacy leg reading `request.json()`/`text()` instead of
            // the pass-through parsedBody — still receive the body, and replace
            // the entity headers that described the original raw bytes.
            const serialized: string | undefined = JSON.stringify(parsedBody);
            headers.delete('content-encoding');
            headers.delete('transfer-encoding');
            if (serialized === undefined) {
                headers.delete('content-length');
            } else {
                body = serialized;
                headers.set('content-length', String(new TextEncoder().encode(serialized).byteLength));
            }
        }
    }

    return new Request(url, {
        method,
        headers,
        signal,
        ...(body !== undefined && { body })
    });
}
