/**
 * `createMcpHandler` — the HTTP entry point for serving the 2026-07-28 protocol
 * revision, with 2025-era serving available as an opt-in slot.
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
 *   When the `legacy` slot is configured they are handed to it untouched; when
 *   it is not, the endpoint is modern-only strict and answers the documented
 *   rejection cells. There is no silent 2025 serving without the slot.
 *
 * The entry performs no Origin/Host validation (mount the origin/host
 * validation middleware in front of it) and no token verification — `authInfo`
 * is pass-through from the caller and is never derived from request headers.
 */
import type {
    AuthInfo,
    ClientCapabilities,
    Implementation,
    InboundLadderRejection,
    InboundLegacyRoute,
    InboundModernRoute,
    JSONRPCNotification,
    JSONRPCRequest
} from '@modelcontextprotocol/core';
import {
    classifyInboundRequest,
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    modernOnlyStrictRejection,
    requestMetaOf,
    SdkError,
    SdkErrorCode,
    setNegotiatedProtocolVersion,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS,
    UnsupportedProtocolVersionError
} from '@modelcontextprotocol/core';

import { invoke } from './invoke.js';
import { McpServer } from './mcp.js';
import type { PerRequestResponseMode } from './perRequestTransport.js';
import type { Server } from './server.js';
import { installModernOnlyHandlers, seedClientIdentityFromEnvelope } from './server.js';
import { WebStandardStreamableHTTPServerTransport } from './streamableHttp.js';

/* ------------------------------------------------------------------------ *
 * Factory and handler types
 * ------------------------------------------------------------------------ */

/**
 * Per-request construction context handed to an {@linkcode McpServerFactory}.
 *
 * Zero-argument factories remain assignable unchanged; the context exists for
 * factories that vary by principal or era (for example multi-tenant servers
 * keyed off `authInfo`, or a factory that registers extra surface only for one
 * era).
 */
export interface McpRequestContext {
    /**
     * The protocol era of the request the constructed instance will serve:
     * `modern` for 2026-07-28 (per-request envelope) traffic, `legacy` for
     * 2025-era traffic served through the `legacy: 'stateless'` slot.
     */
    era: 'legacy' | 'modern';
    /** Validated authentication information passed by the caller of the handler face (pass-through). */
    authInfo?: AuthInfo;
    /** The original HTTP request being served, when available. */
    requestInfo?: Request;
}

/**
 * A factory producing a fresh {@linkcode McpServer} (or low-level
 * {@linkcode Server}) instance for one request. The same factory backs both
 * the modern path and the `legacy: 'stateless'` slot — define your tools,
 * resources and prompts once and serve them to both eras.
 */
export type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

/** Caller-provided per-request inputs for {@linkcode McpHttpHandler.fetch} and legacy slot handlers. */
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
 * A fetch-shaped handler serving 2025-era traffic for the `legacy` slot:
 * receives the original request untouched (plus the caller-provided
 * pass-through options) and produces the HTTP response.
 */
export type LegacyHttpHandler = (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;

/** Options for {@linkcode createMcpHandler}. */
export interface CreateMcpHandlerOptions {
    /**
     * How 2025-era (non-envelope) traffic is served:
     *
     * - omitted — modern-only strict: legacy-classified requests are rejected
     *   with the unsupported-protocol-version error naming the endpoint's
     *   supported revisions (legacy-classified notifications are acknowledged
     *   with `202` and dropped). **There is no silent 2025 serving.**
     * - `'stateless'` — serve legacy traffic with the per-request stateless
     *   idiom (a fresh instance from the same factory and a streamable HTTP
     *   transport constructed with only `sessionIdGenerator: undefined`).
     *   Equivalent to passing {@linkcode legacyStatelessFallback | legacyStatelessFallback(factory)}.
     * - a handler — bring your own legacy serving (for example an existing
     *   sessionful streamable HTTP wiring); requests are handed to it
     *   byte-untouched and its lifecycle stays yours.
     */
    legacy?: 'stateless' | LegacyHttpHandler;
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
     * `'stateless'` slot is per-request by construction, and a bring-your-own
     * legacy handler's lifecycle stays with its owner.
     */
    close: () => Promise<void>;
}

/* ------------------------------------------------------------------------ *
 * Shared response helpers
 * ------------------------------------------------------------------------ */

function jsonRpcErrorResponse(httpStatus: number, code: number, message: string, data?: unknown): Response {
    return Response.json(
        {
            jsonrpc: '2.0',
            error: { code, message, ...(data !== undefined && { data }) },
            id: null
        },
        { status: httpStatus }
    );
}

function rejectionResponse(rejection: InboundLadderRejection): Response {
    return jsonRpcErrorResponse(rejection.httpStatus, rejection.code, rejection.message, rejection.data);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/**
 * Whether the given factory product has the (forthcoming) subscriptions feature
 * configured. The subscriptions registry does not exist yet, so this currently
 * always reports `false`; the subscriptions feature replaces this predicate
 * when it lands, which arms the `responseMode: 'json'` startup warning below.
 */
function hasConfiguredSubscriptions(_product: McpServer | Server): boolean {
    return false;
}

function internalServerErrorResponse(): Response {
    return jsonRpcErrorResponse(500, -32_603, 'Internal server error');
}

/* ------------------------------------------------------------------------ *
 * The canonical legacy slot value
 * ------------------------------------------------------------------------ */

/**
 * The canonical `legacy` slot value: per-request stateless serving of 2025-era
 * traffic using the same factory as the modern path.
 *
 * Each POST is served by a fresh instance from the factory connected to a
 * fresh streamable HTTP transport constructed with only
 * `sessionIdGenerator: undefined` — the established stateless idiom, unchanged.
 * Because serving is per-request and stateless, GET and DELETE (2025 session
 * operations) are answered with `405` / `Method not allowed.`, exactly like the
 * canonical stateless example. `createMcpHandler(factory, { legacy: 'stateless' })`
 * is shorthand for passing `legacyStatelessFallback(factory)` here explicitly.
 */
export function legacyStatelessFallback(factory: McpServerFactory): LegacyHttpHandler {
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
            // The closest fetch-world analog of the example's close-on-response-end:
            // tear the per-request pair down when the client goes away.
            request.signal?.addEventListener('abort', teardown, { once: true });

            const response = await transport.handleRequest(request, {
                ...(options?.authInfo !== undefined && { authInfo: options.authInfo }),
                ...(options?.parsedBody !== undefined && { parsedBody: options.parsedBody })
            });
            if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
                // Non-streaming exchange: the response is complete, release the pair now.
                teardown();
            }
            return response;
        } catch {
            return internalServerErrorResponse();
        }
    };
}

/* ------------------------------------------------------------------------ *
 * The entry
 * ------------------------------------------------------------------------ */

/**
 * Creates an HTTP handler that serves the 2026-07-28 protocol revision from a
 * per-request server factory, with 2025-era serving available through the
 * opt-in `legacy` slot.
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
 * backs the modern path and the `legacy: 'stateless'` slot, so the two eras
 * can never drift apart. Power users who want to compose the routing
 * themselves (for example to mount the modern path and an existing legacy
 * deployment on different routes) can use the exported building blocks
 * directly: {@linkcode classifyInboundRequest} for the era decision and
 * `PerRequestHTTPServerTransport` for single-exchange serving.
 *
 * The entry performs no token verification: `authInfo` given to the faces is
 * passed through to handlers and the factory as-is and is never derived from
 * request headers.
 */
export function createMcpHandler(factory: McpServerFactory, options: CreateMcpHandlerOptions = {}): McpHttpHandler {
    const { legacy, onerror, responseMode } = options;
    const legacyHandler: LegacyHttpHandler | undefined = legacy === 'stateless' ? legacyStatelessFallback(factory) : legacy;

    /** Modern per-request instances with an exchange still in flight (close() tears these down). */
    const inflight = new Set<Server>();
    let closed = false;
    let warnedJsonModeSubscriptions = false;

    const reportError = (error: Error) => {
        try {
            onerror?.(error);
        } catch {
            // Reporting must never alter the response.
        }
    };

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
            return jsonRpcErrorResponse(400, error.code, error.message, error.data);
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

        if (route.messageKind === 'request') {
            const meta = requestMetaOf((message as JSONRPCRequest).params);
            if (meta !== undefined) {
                seedClientIdentityFromEnvelope(server, {
                    clientInfo: meta[CLIENT_INFO_META_KEY] as Implementation | undefined,
                    clientCapabilities: meta[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined
                });
            }
        }

        if (responseMode === 'json' && !warnedJsonModeSubscriptions && hasConfiguredSubscriptions(product)) {
            warnedJsonModeSubscriptions = true;
            // eslint-disable-next-line no-console
            console.warn(
                "Warning: responseMode: 'json' drops mid-call notifications, but this server configures subscriptions. " +
                    'Subscription (listen) streams are always served over SSE; other notifications emitted before a result will be dropped.'
            );
        }

        // Track the instance until its exchange tears down so close() can abort it.
        const previousOnClose = server.onclose;
        inflight.add(server);
        server.onclose = () => {
            inflight.delete(server);
            previousOnClose?.();
        };

        // Listen-class streams are always SSE: even under 'json', a listen
        // request's per-request transport keeps the lazy upgrade available.
        const effectiveResponseMode: PerRequestResponseMode | undefined =
            responseMode === 'json' && route.messageKind === 'request' && (message as JSONRPCRequest).method === 'subscriptions/listen'
                ? 'auto'
                : responseMode;

        try {
            const response = await invoke(product, message, {
                classification: route.classification,
                request,
                ...(authInfo !== undefined && { authInfo }),
                ...(effectiveResponseMode !== undefined && { responseMode: effectiveResponseMode })
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
            reportError(toError(error));
            return internalServerErrorResponse();
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
        return rejectionResponse(strict);
    }

    async function handle(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
        const httpMethod = request.method.toUpperCase();
        const authInfo = requestOptions?.authInfo;

        let body: unknown;
        let parsedBody = requestOptions?.parsedBody;
        let forwardRequest = request;
        let unparseable = false;

        if (httpMethod === 'POST') {
            if (parsedBody === undefined) {
                // Read the body exactly once for classification, keeping an
                // unread copy of the original bytes for the legacy slot
                // (web-standard request bodies are single-use).
                forwardRequest = request.clone();
                let bodyText: string;
                try {
                    bodyText = await request.text();
                } catch {
                    return jsonRpcErrorResponse(400, -32_700, 'Parse error: the request body could not be read');
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
                // No JSON body to classify: there is no envelope claim, so this
                // is legacy traffic when a slot is configured (the legacy leg
                // answers its own parse error, unchanged), and a parse error
                // otherwise.
                if (legacyHandler !== undefined) {
                    return legacyHandler(forwardRequest, { ...(authInfo !== undefined && { authInfo }) });
                }
                return jsonRpcErrorResponse(400, -32_700, 'Parse error: the request body is not valid JSON');
            }
        }

        const outcome = classifyInboundRequest({
            httpMethod,
            protocolVersionHeader: request.headers.get('mcp-protocol-version') ?? undefined,
            mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
            ...(body !== undefined && { body })
        });

        switch (outcome.kind) {
            case 'reject': {
                reportError(new Error(`Rejected inbound request (${outcome.cell}): ${outcome.message}`));
                return rejectionResponse(outcome);
            }
            case 'modern': {
                return serveModern(outcome, body as JSONRPCRequest | JSONRPCNotification, request, authInfo);
            }
            case 'legacy': {
                return serveLegacyRoute(outcome, forwardRequest, authInfo, parsedBody);
            }
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
            return internalServerErrorResponse();
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
            const request = await nodeRequestToFetchRequest(req, parsedBody !== undefined, abort.signal);
            response = await fetchFace(request, {
                ...(req.auth !== undefined && { authInfo: req.auth }),
                ...(parsedBody !== undefined && { parsedBody })
            });
        } catch (error) {
            reportError(toError(error));
            response = internalServerErrorResponse();
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
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                if (value !== undefined) {
                    res.write(value);
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
        close: async () => {
            closed = true;
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

async function nodeRequestToFetchRequest(req: NodeIncomingMessageLike, hasParsedBody: boolean, signal: AbortSignal): Promise<Request> {
    const method = (req.method ?? 'GET').toUpperCase();
    const host = singleHeaderValue(req.headers['host']) ?? 'localhost';
    const url = `http://${host}${req.url ?? '/'}`;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) {
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

    // The body is collected as text: MCP request bodies are JSON, and a string
    // body keeps the constructed Request portable across runtime lib versions.
    let body: string | undefined;
    if (!hasParsedBody && method !== 'GET' && method !== 'HEAD') {
        const decoder = new TextDecoder();
        let collected = '';
        for await (const chunk of req) {
            collected += typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
        }
        collected += decoder.decode();
        if (collected.length > 0) {
            body = collected;
        }
    }

    return new Request(url, {
        method,
        headers,
        signal,
        ...(body !== undefined && { body })
    });
}
