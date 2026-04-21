import type {
    AuthInfo,
    DispatchEnv,
    DispatchOutput,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse
} from '@modelcontextprotocol/core';
import {
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    isInitializeRequest,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    JSONRPCMessageSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';

import type { Backchannel2511 } from './backchannel2511.js';
import type { SessionCompat } from './sessionCompat.js';

export type StreamId = string;
export type EventId = string;

/**
 * Interface for resumability support via event storage.
 */
export interface EventStore {
    /**
     * Stores an event for later retrieval.
     * @param streamId ID of the stream the event belongs to
     * @param message The JSON-RPC message to store
     * @returns The generated event ID for the stored event
     */
    storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;

    /**
     * Replays events stored after the given event ID, calling `send` for each.
     * @returns The stream ID the replayed events belong to
     */
    replayEventsAfter(
        lastEventId: EventId,
        opts: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
    ): Promise<StreamId>;
}

/**
 * Structural interface for the server passed to {@linkcode shttpHandler}. Matches the
 * {@linkcode Dispatcher} surface; `McpServer` (which extends `Dispatcher`) satisfies it.
 */
export interface McpServerLike {
    dispatch(request: JSONRPCRequest, env?: DispatchEnv): AsyncIterable<DispatchOutput>;
    dispatchNotification(notification: JSONRPCNotification): Promise<void>;
}

/**
 * Options for {@linkcode shttpHandler}.
 */
export interface ShttpHandlerOptions {
    /**
     * If `true`, return a single `application/json` response instead of an SSE stream.
     * Progress notifications yielded by handlers are dropped in this mode.
     *
     * @default false
     */
    enableJsonResponse?: boolean;

    /**
     * Pre-2026-06 session compatibility. When provided, the handler validates the
     * `mcp-session-id` header, mints a session on `initialize`, and supports the
     * standalone GET subscription stream and DELETE session termination. When omitted,
     * the handler is stateless: GET/DELETE return 405.
     */
    session?: SessionCompat;

    /**
     * Pre-2026-06 server-to-client request backchannel. When provided alongside `session`,
     * the handler supplies `env.send` to dispatched handlers (so `ctx.mcpReq.elicitInput()` etc.
     * work over the open POST SSE stream) and routes incoming JSON-RPC responses to the
     * waiting `env.send` promise. Version-gated: only active for sessions whose negotiated
     * protocol version is below `2026-06-30`.
     */
    backchannel?: Backchannel2511;

    /**
     * Event store for SSE resumability via `Last-Event-ID`. When configured, every
     * outgoing SSE event is persisted and a priming event is sent at stream start.
     */
    eventStore?: EventStore;

    /**
     * Retry interval in milliseconds, sent in the SSE `retry` field of priming events.
     */
    retryInterval?: number;

    /**
     * Protocol versions accepted in the `mcp-protocol-version` header.
     *
     * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
     */
    supportedProtocolVersions?: string[];

    /** Called for non-fatal errors (validation failures, stream write errors). */
    onerror?: (error: Error) => void;
}

/**
 * Per-request extras passed alongside the {@linkcode Request}.
 */
export interface ShttpRequestExtra {
    /** Pre-parsed body (e.g. from `express.json()`). When omitted, `req.json()` is used. */
    parsedBody?: unknown;
    /** Validated auth token info from upstream middleware. */
    authInfo?: AuthInfo;
}

function jsonError(status: number, code: number, message: string, extra?: { headers?: Record<string, string>; data?: string }): Response {
    const error: { code: number; message: string; data?: string } = { code, message };
    if (extra?.data !== undefined) error.data = extra.data;
    return Response.json(
        { jsonrpc: '2.0', error, id: null },
        { status, headers: { 'Content-Type': 'application/json', ...extra?.headers } }
    );
}

function writeSSEEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: InstanceType<typeof TextEncoder>,
    message: JSONRPCMessage,
    eventId?: string
): boolean {
    try {
        let data = 'event: message\n';
        if (eventId) data += `id: ${eventId}\n`;
        data += `data: ${JSON.stringify(message)}\n\n`;
        controller.enqueue(encoder.encode(data));
        return true;
    } catch {
        return false;
    }
}

const SSE_HEADERS: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
};

/**
 * Creates a Web-standard `(Request) => Promise<Response>` handler for the MCP Streamable HTTP
 * transport, driven by {@linkcode McpServerLike.dispatch} per request.
 *
 * No `_streamMapping`, `_requestToStreamMapping`, or `relatedRequestId` routing — the response
 * stream is in lexical scope of the request that opened it. Session lifecycle (when enabled)
 * lives in the supplied {@linkcode SessionCompat}, not on this handler.
 */
export function shttpHandler(
    server: McpServerLike,
    options: ShttpHandlerOptions = {}
): (req: Request, extra?: ShttpRequestExtra) => Promise<Response> {
    const enableJsonResponse = options.enableJsonResponse ?? false;
    const session = options.session;
    const backchannel = options.backchannel;
    const eventStore = options.eventStore;
    const retryInterval = options.retryInterval;
    const supportedProtocolVersions = options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    const onerror = options.onerror;

    function backchannelEnabled(sessionId: string | undefined, clientProtocolVersion: string): boolean {
        if (!backchannel || sessionId === undefined) return false;
        const negotiated = session?.negotiatedVersion(sessionId) ?? clientProtocolVersion;
        return negotiated < '2026-06-30';
    }

    function validateProtocolVersion(req: Request): Response | undefined {
        const v = req.headers.get('mcp-protocol-version');
        if (v !== null && !supportedProtocolVersions.includes(v)) {
            const msg = `Bad Request: Unsupported protocol version: ${v} (supported versions: ${supportedProtocolVersions.join(', ')})`;
            onerror?.(new Error(msg));
            return jsonError(400, -32_000, msg);
        }
        return undefined;
    }

    async function writePrimingEvent(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        streamId: string,
        protocolVersion: string
    ): Promise<void> {
        if (!eventStore) return;
        if (protocolVersion < '2025-11-25') return;
        const primingId = await eventStore.storeEvent(streamId, {} as JSONRPCMessage);
        const retry = retryInterval === undefined ? '' : `retry: ${retryInterval}\n`;
        controller.enqueue(encoder.encode(`id: ${primingId}\n${retry}data: \n\n`));
    }

    async function emit(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        streamId: string,
        message: JSONRPCMessage
    ): Promise<void> {
        const eventId = eventStore ? await eventStore.storeEvent(streamId, message) : undefined;
        if (!writeSSEEvent(controller, encoder, message, eventId)) {
            onerror?.(new Error('Failed to write SSE event'));
        }
    }

    async function handlePost(req: Request, extra?: ShttpRequestExtra): Promise<Response> {
        const accept = req.headers.get('accept');
        if (!accept?.includes('application/json') || !accept.includes('text/event-stream')) {
            onerror?.(new Error('Not Acceptable: Client must accept both application/json and text/event-stream'));
            return jsonError(406, -32_000, 'Not Acceptable: Client must accept both application/json and text/event-stream');
        }

        const ct = req.headers.get('content-type');
        if (!ct?.includes('application/json')) {
            onerror?.(new Error('Unsupported Media Type: Content-Type must be application/json'));
            return jsonError(415, -32_000, 'Unsupported Media Type: Content-Type must be application/json');
        }

        let raw: unknown;
        if (extra?.parsedBody === undefined) {
            try {
                raw = await req.json();
            } catch (error) {
                onerror?.(error as Error);
                return jsonError(400, -32_700, 'Parse error: Invalid JSON');
            }
        } else {
            raw = extra.parsedBody;
        }

        let messages: JSONRPCMessage[];
        try {
            messages = Array.isArray(raw) ? raw.map(m => JSONRPCMessageSchema.parse(m)) : [JSONRPCMessageSchema.parse(raw)];
        } catch (error) {
            onerror?.(error as Error);
            return jsonError(400, -32_700, 'Parse error: Invalid JSON-RPC message');
        }

        let sessionId: string | undefined;
        let isInitialize = false;
        if (session) {
            const v = await session.validate(req, messages);
            if (!v.ok) return v.response;
            sessionId = v.sessionId;
            isInitialize = v.isInitialize;
        }
        if (!isInitialize) {
            const protoErr = validateProtocolVersion(req);
            if (protoErr) return protoErr;
        }

        const requests = messages.filter(m => isJSONRPCRequest(m));
        const notifications = messages.filter(m => isJSONRPCNotification(m));
        const responses = messages.filter(
            (m): m is JSONRPCResultResponse | JSONRPCErrorResponse => isJSONRPCResultResponse(m) || isJSONRPCErrorResponse(m)
        );

        for (const n of notifications) {
            void server.dispatchNotification(n).catch(error => onerror?.(error as Error));
        }

        if (backchannel && sessionId !== undefined) {
            for (const r of responses) backchannel.handleResponse(sessionId, r);
        }

        if (requests.length === 0) {
            return new Response(null, { status: 202 });
        }

        const initReq = messages.find(m => isInitializeRequest(m));
        const clientProtocolVersion =
            initReq && isInitializeRequest(initReq)
                ? initReq.params.protocolVersion
                : (req.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION);

        const baseEnv: DispatchEnv = { sessionId, authInfo: extra?.authInfo, httpReq: req };
        const useBackchannel = backchannelEnabled(sessionId, clientProtocolVersion);

        if (enableJsonResponse) {
            const out: JSONRPCMessage[] = [];
            for (const r of requests) {
                for await (const item of server.dispatch(r, baseEnv)) {
                    if (item.kind === 'response') out.push(item.message);
                }
            }
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
            const body = out.length === 1 ? out[0] : out;
            return Response.json(body, { status: 200, headers });
        }

        const streamId = crypto.randomUUID();
        const encoder = new TextEncoder();
        const headers: Record<string, string> = { ...SSE_HEADERS };
        if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;

        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                const writeSSE = (msg: JSONRPCMessage) => void emit(controller, encoder, streamId, msg);
                const env: DispatchEnv =
                    useBackchannel && backchannel && sessionId !== undefined
                        ? { ...baseEnv, send: backchannel.makeEnvSend(sessionId, writeSSE) }
                        : baseEnv;
                void (async () => {
                    try {
                        await writePrimingEvent(controller, encoder, streamId, clientProtocolVersion);
                        for (const r of requests) {
                            for await (const out of server.dispatch(r, env)) {
                                await emit(controller, encoder, streamId, out.message);
                            }
                        }
                    } catch (error) {
                        onerror?.(error as Error);
                    } finally {
                        try {
                            controller.close();
                        } catch {
                            // Already closed.
                        }
                    }
                })();
            }
        });

        return new Response(readable, { status: 200, headers });
    }

    async function handleGet(req: Request): Promise<Response> {
        if (!session) {
            return jsonError(405, -32_000, 'Method Not Allowed: stateless handler does not support GET stream', {
                headers: { Allow: 'POST' }
            });
        }

        const accept = req.headers.get('accept');
        if (!accept?.includes('text/event-stream')) {
            onerror?.(new Error('Not Acceptable: Client must accept text/event-stream'));
            return jsonError(406, -32_000, 'Not Acceptable: Client must accept text/event-stream');
        }

        const v = session.validateHeader(req);
        if (!v.ok) return v.response;
        const protoErr = validateProtocolVersion(req);
        if (protoErr) return protoErr;
        const sessionId = v.sessionId!;

        if (eventStore) {
            const lastEventId = req.headers.get('last-event-id');
            if (lastEventId) {
                return replayEvents(lastEventId, sessionId);
            }
        }

        if (session.hasStandaloneStream(sessionId)) {
            onerror?.(new Error('Conflict: Only one SSE stream is allowed per session'));
            return jsonError(409, -32_000, 'Conflict: Only one SSE stream is allowed per session');
        }

        const encoder = new TextEncoder();
        const standaloneStreamId = `_GET_${sessionId}`;
        const headers: Record<string, string> = { ...SSE_HEADERS, 'mcp-session-id': sessionId };
        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                session.setStandaloneStream(sessionId, controller);
                backchannel?.setStandaloneWriter(sessionId, msg =>
                    void emit(controller, encoder, standaloneStreamId, msg)
                );
                void writePrimingEvent(controller, encoder, standaloneStreamId, session.negotiatedVersion(sessionId) ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION);
            },
            cancel: () => {
                session.setStandaloneStream(sessionId, undefined);
                backchannel?.setStandaloneWriter(sessionId, undefined);
            }
        });
        return new Response(readable, { headers });
    }

    async function replayEvents(lastEventId: string, sessionId: string): Promise<Response> {
        if (!eventStore) {
            return jsonError(400, -32_000, 'Event store not configured');
        }
        const encoder = new TextEncoder();
        const headers: Record<string, string> = { ...SSE_HEADERS, 'mcp-session-id': sessionId };
        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                void (async () => {
                    try {
                        await eventStore.replayEventsAfter(lastEventId, {
                            send: async (eventId, message) => {
                                writeSSEEvent(controller, encoder, message, eventId);
                            }
                        });
                        if (session) session.setStandaloneStream(sessionId, controller);
                    } catch (error) {
                        onerror?.(error as Error);
                        try {
                            controller.close();
                        } catch {
                            // Already closed.
                        }
                    }
                })();
            },
            cancel: () => {
                session?.setStandaloneStream(sessionId, undefined);
            }
        });
        return new Response(readable, { headers });
    }

    async function handleDelete(req: Request): Promise<Response> {
        if (!session) {
            return jsonError(405, -32_000, 'Method Not Allowed: stateless handler does not support session DELETE', {
                headers: { Allow: 'POST' }
            });
        }
        const v = session.validateHeader(req);
        if (!v.ok) return v.response;
        const protoErr = validateProtocolVersion(req);
        if (protoErr) return protoErr;
        backchannel?.closeSession(v.sessionId!);
        await session.delete(v.sessionId!);
        return new Response(null, { status: 200 });
    }

    return async (req: Request, extra?: ShttpRequestExtra): Promise<Response> => {
        try {
            switch (req.method) {
                case 'POST': {
                    return await handlePost(req, extra);
                }
                case 'GET': {
                    return await handleGet(req);
                }
                case 'DELETE': {
                    return await handleDelete(req);
                }
                default: {
                    return jsonError(405, -32_000, 'Method not allowed.', { headers: { Allow: 'GET, POST, DELETE' } });
                }
            }
        } catch (error) {
            onerror?.(error as Error);
            return jsonError(400, -32_700, 'Parse error', { data: String(error) });
        }
    };
}
