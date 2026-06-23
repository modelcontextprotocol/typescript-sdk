/**
 * `toNodeHandler` — adapt the web-standard {@linkcode McpHttpHandler} returned
 * by `createMcpHandler` to a Node.js `(req, res, parsedBody?)` request handler.
 *
 * The handler itself is web-standards-only (`{ fetch, close, notify, bus }` — the
 * shape Workers/Bun/Deno expect from `export default`). Node frameworks
 * (Express, Fastify, plain `node:http`) wrap it once with this helper:
 *
 * ```ts
 * import { createMcpHandler } from '@modelcontextprotocol/server';
 * import { toNodeHandler } from '@modelcontextprotocol/node';
 *
 * const handler = createMcpHandler(factory);
 * app.all('/mcp', toNodeHandler(handler));
 * // or, when a body parser already consumed the stream:
 * const node = toNodeHandler(handler);
 * app.all('/mcp', (req, res) => void node(req, res, req.body));
 * ```
 *
 * The Node request/response shapes are duck-typed (kept structural so this
 * module stays free of `node:` imports); the conversion reads `req.auth`
 * (validated authentication info attached by upstream middleware) and forwards
 * it as the handler's pass-through `authInfo`.
 */
import type { AuthInfo, McpHandlerRequestOptions } from '@modelcontextprotocol/server';

/**
 * Minimal duck-typed shape of a Node.js `IncomingMessage` accepted by
 * {@linkcode toNodeHandler}. Kept structural so the adapter stays free of
 * `node:` imports.
 */
export interface NodeIncomingMessageLike extends AsyncIterable<unknown> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    /** Validated authentication info attached by upstream middleware (pass-through). */
    auth?: AuthInfo;
}

/** Minimal duck-typed shape of a Node.js `ServerResponse` accepted by {@linkcode toNodeHandler}. */
export interface NodeServerResponseLike {
    writeHead(statusCode: number, headers?: Record<string, string>): unknown;
    write(chunk: string | Uint8Array): unknown;
    end(chunk?: string | Uint8Array): unknown;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    destroyed?: boolean;
}

/**
 * The web-standard fetch face of an `McpHttpHandler` (or any
 * fetch-shaped MCP handler) — the only surface {@linkcode toNodeHandler}
 * touches. Accepting the face structurally keeps the adapter usable with
 * hand-wired compositions that route over `isLegacyRequest` and produce a
 * `Response` directly.
 */
export interface FetchLikeMcpHandler {
    fetch: (request: Request, options?: McpHandlerRequestOptions) => Promise<Response>;
}

/**
 * A Node.js `(req, res, parsedBody?)` request handler produced by
 * {@linkcode toNodeHandler}. The third argument is an optional pre-parsed body
 * (`req.body` from `express.json()`); a function third argument (Express's
 * `next` when the handler is mounted as middleware) is ignored.
 */
export type NodeMcpRequestHandler = (req: NodeIncomingMessageLike, res: NodeServerResponseLike, parsedBody?: unknown) => Promise<void>;

/** Options for {@linkcode toNodeHandler}. */
export interface ToNodeHandlerOptions {
    /**
     * Called when the adapter answers `500` because request conversion or
     * `handler.fetch` itself threw (e.g. a closed handler). Restores the
     * observability the removed `.node` face had via the entry's own
     * `onerror` — entry-internal failures are still reported through
     * `handler.fetch` and surface via the entry's `onerror` option as before.
     */
    onerror?: (error: Error) => void;
}

/**
 * Adapts a web-standard MCP handler (`handler.fetch`) to a Node.js
 * `(req, res, parsedBody?)` request handler. The returned function converts the
 * Node request to a web-standard `Request`, calls `handler.fetch`, then writes
 * the `Response` back to `res` (honoring write backpressure for streamed SSE
 * responses).
 *
 * `req.auth` is forwarded as the handler's pass-through `authInfo`. A function
 * third argument (Express's `next`) is ignored, never treated as a body.
 *
 * Pass `{ onerror }` to observe the adapter-level error fallback (request
 * conversion / `handler.fetch` throw) before the `500` response is written.
 */
export function toNodeHandler(handler: FetchLikeMcpHandler, opts?: ToNodeHandlerOptions): NodeMcpRequestHandler {
    return async (req, res, parsedBody) => {
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
        if (res.destroyed === true) {
            abort.abort();
        }

        let response: Response;
        try {
            const request = await nodeRequestToFetchRequest(req, parsedBody, abort.signal);
            response = await handler.fetch(request, {
                ...(req.auth !== undefined && { authInfo: req.auth }),
                ...(parsedBody !== undefined && { parsedBody })
            });
        } catch (error) {
            try {
                opts?.onerror?.(error instanceof Error ? error : new Error(String(error)));
            } catch {
                // Reporting must never alter the response.
            }
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
        // Honor write backpressure: when write() reports a full buffer (Node's
        // `false` return), wait for the response to drain before pulling the
        // next chunk. The abort signal (wired to 'close' above, and seeded
        // from `res.destroyed` at entry to cover the pre-registration window
        // when 'close' already fired during async middleware) is the single
        // termination source — racing it against the drain wait means a
        // vanished client cannot park the loop, and breaking out of the async
        // iterator calls return() to cancel the upstream stream.
        let drainResolve: (() => void) | undefined;
        const releaseDrainWait = () => {
            drainResolve?.();
            drainResolve = undefined;
        };
        res.on('drain', releaseDrainWait);
        const closed = new Promise<void>(resolve => {
            abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        try {
            for await (const chunk of response.body) {
                if (abort.signal.aborted) {
                    break;
                }
                if (res.write(chunk) === false) {
                    await Promise.race([
                        new Promise<void>(resolve => {
                            drainResolve = resolve;
                        }),
                        closed
                    ]);
                }
            }
        } catch {
            // Stream aborted upstream; the abort signal already cancelled the exchange.
        }
        finished = true;
        res.end();
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
            // documented `(req, res, req.body)` mounting behind
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

/* ------------------------------------------------------------------------ *
 * Adapter-level error fallback (request conversion failure / closed handler)
 * ------------------------------------------------------------------------ */

/**
 * The JSON-RPC id to echo on an adapter-built error response: the body's `id`
 * when the body is a single JSON-RPC request whose id is a string or number,
 * `null` otherwise.
 */
function echoableRequestId(body: unknown): string | number | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const { method, id } = body as { method?: unknown; id?: unknown };
    if (typeof method !== 'string') {
        return null;
    }
    return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function internalServerErrorResponse(id: string | number | null): Response {
    return Response.json({ jsonrpc: '2.0', error: { code: -32_603, message: 'Internal server error' }, id }, { status: 500 });
}
