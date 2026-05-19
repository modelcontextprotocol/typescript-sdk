import type {
    AuthInfo,
    ClientMeta,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCRequest,
    ListenContext,
    StatelessHandlers
} from '@modelcontextprotocol/core';
import {
    isJSONRPCNotification,
    isJSONRPCRequest,
    isStatelessProtocolVersion,
    JSONRPC_VERSION,
    META_KEYS,
    parseClientMeta,
    ProtocolErrorCode
} from '@modelcontextprotocol/core';

/** Per-request options the framework adapter may supply. */
export interface StatelessHttpRequestOptions {
    authInfo?: AuthInfo;
    /** Pre-parsed body (skips reading from `req`). */
    parsedBody?: unknown;
    /** See {@linkcode ListenContext.onAuthorizeResourceSubscription}. */
    onAuthorizeResourceSubscription?: ListenContext['onAuthorizeResourceSubscription'];
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_SIZE = 64;

/**
 * Handles one 2026-06 HTTP request via the supplied {@linkcode StatelessHandlers}.
 * Shared by `WebStandardStreamableHTTPServerTransport`'s router branch and the
 * standalone `handleHttp` entry.
 *
 * - POST only (GET/DELETE → 405).
 * - `subscriptions/listen` → SSE stream from `handlers.listen`; rejected if
 *   inside a batch (`-32600`).
 * - Otherwise: per-request `handlers.dispatch`. Batch requests are dispatched
 *   in parallel; each request's `_meta` is parsed independently.
 * - SSE if `Accept` includes `text/event-stream`; else JSON.
 * - HTTP status reflects the single-response error code (404 for `-32601`,
 *   400 for `InvalidParams`/`HeaderMismatch`/`-32003`, 500 for `InternalError`).
 */
export async function statelessHttpHandler(
    handlers: StatelessHandlers,
    req: Request,
    options?: StatelessHttpRequestOptions & { maxBodyBytes?: number }
): Promise<Response> {
    if (req.method !== 'POST') {
        return jsonError(405, ProtocolErrorCode.InvalidRequest, 'Method Not Allowed (stateless server accepts POST only)', null, {
            Allow: 'POST'
        });
    }

    // CSRF barrier: a same-origin policy lets pages POST cross-origin only with
    // a "simple" Content-Type (form/text); requiring application/json forces a
    // preflight. Exact media-type match (parameters like `; charset=utf-8` are
    // stripped); avoids substring false-positives like `application/jsonp`.
    // Checked even when `parsedBody` is supplied so framework adapters that
    // pre-parse do not silently bypass the barrier.
    const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (ct !== 'application/json') {
        return jsonError(415, ProtocolErrorCode.InvalidRequest, 'Unsupported Media Type: Content-Type must be application/json', null);
    }

    const acceptsSse = (req.headers.get('accept') ?? '').includes('text/event-stream');
    const headerVersion = req.headers.get('mcp-protocol-version');

    let body: unknown;
    if (options?.parsedBody === undefined) {
        // Always use the bounded streaming reader; never trust Content-Length
        // (a forged-small CL would otherwise bypass the limit via req.json()).
        const text = await readBoundedText(req, options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        if (text === undefined) {
            return jsonError(413, ProtocolErrorCode.InvalidRequest, 'Request body too large', null);
        }
        try {
            body = JSON.parse(text);
        } catch {
            return jsonError(400, ProtocolErrorCode.ParseError, 'Parse error', null);
        }
    } else {
        body = options.parsedBody;
    }

    const messages: unknown[] = Array.isArray(body) ? body : [body];
    if (messages.length === 0) {
        // JSON-RPC 2.0 §6: an empty batch is an invalid request.
        return jsonError(400, ProtocolErrorCode.InvalidRequest, 'Invalid Request: empty batch', null);
    }

    if (messages.length > MAX_BATCH_SIZE) {
        return jsonError(400, ProtocolErrorCode.InvalidRequest, `Batch too large (max ${MAX_BATCH_SIZE})`, null);
    }

    // Reject any message that is neither a JSON-RPC request nor a notification
    // (e.g., a stray response object) so it does not silently fall through to
    // an empty-batch dispatch.
    for (const m of messages) {
        if (!isJSONRPCRequest(m) && !isJSONRPCNotification(m)) {
            return jsonError(400, ProtocolErrorCode.InvalidRequest, 'Invalid Request: not a JSON-RPC request or notification', null);
        }
    }

    // Validate _meta on every request (per-request, not batch-first-only) and
    // keep the parsed result so dispatch does not parse again. Per JSON-RPC 2.0
    // batch semantics, an invalid item produces an error response at that index
    // rather than failing the whole batch.
    const requests: Array<{ r: JSONRPCRequest; meta: ClientMeta } | { r: JSONRPCRequest; error: JSONRPCErrorResponse }> = [];
    for (const r of messages.filter(m => isJSONRPCRequest(m))) {
        const meta = parseClientMeta(r.params);
        const err = validateRequestMeta(meta, headerVersion);
        if (err) {
            requests.push({ r, error: { jsonrpc: JSONRPC_VERSION, id: r.id, error: err } });
        } else {
            requests.push({ r, meta });
        }
    }
    // Single non-batch request with invalid _meta: keep the existing 400 + single
    // error-object behavior so clients can rely on the HTTP status.
    if (!Array.isArray(body) && requests.length === 1 && 'error' in requests[0]!) {
        const { error } = requests[0].error;
        return jsonError(statusForCode(error.code), error.code, error.message, requests[0].r.id);
    }
    const isNotificationOnly = requests.length === 0 && messages.every(m => isJSONRPCNotification(m));

    // subscriptions/listen owns the response stream — cannot share a batch.
    const listen = requests.find(({ r }) => r.method === 'subscriptions/listen');
    if (listen !== undefined) {
        if (requests.length > 1 || messages.length > 1) {
            return jsonError(
                400,
                ProtocolErrorCode.InvalidRequest,
                'subscriptions/listen cannot be batched with other messages',
                listen.r.id
            );
        }
        if ('error' in listen) {
            const { error } = listen.error;
            return jsonError(statusForCode(error.code), error.code, error.message, listen.r.id);
        }
        if (!acceptsSse) {
            return jsonError(406, ProtocolErrorCode.InvalidRequest, 'subscriptions/listen requires Accept: text/event-stream', listen.r.id);
        }
        try {
            const { stream, close } = handlers.listen(listen.r, {
                authInfo: options?.authInfo,
                onAuthorizeResourceSubscription: options?.onAuthorizeResourceSubscription
            });
            return sseResponse(stream, { signal: req.signal, onCancel: close });
        } catch (error) {
            return jsonError(
                400,
                ProtocolErrorCode.InvalidParams,
                error instanceof Error ? error.message : 'Invalid listen request',
                listen.r.id
            );
        }
    }

    if (isNotificationOnly) {
        // Spec: server returns 202 for notification-only POSTs.
        return new Response(null, { status: 202 });
    }

    if (acceptsSse) {
        return sseDispatch(handlers, requests, req, options);
    }

    // JSON response: dispatch in parallel; collect responses.
    const responses = await Promise.all(
        requests.map(item =>
            'error' in item
                ? Promise.resolve(item.error)
                : handlers.dispatch(item.r, {
                      signal: req.signal,
                      authInfo: options?.authInfo,
                      httpRequest: req,
                      meta: item.meta,
                      notify: () => {
                          /* JSON branch cannot deliver notifications; spec allows dropping. */
                      }
                  })
        )
    );
    const single = !Array.isArray(body) && responses.length === 1 ? responses[0] : undefined;
    const status = single && 'error' in single ? statusForCode(single.error.code) : 200;
    return Response.json(single ?? responses, { status, headers: { 'Content-Type': 'application/json' } });
}

function validateRequestMeta(meta: ClientMeta, headerVersion: string | null): { code: number; message: string } | undefined {
    if (meta.protocolVersion === undefined) {
        return { code: ProtocolErrorCode.InvalidParams, message: `Missing required _meta.${META_KEYS.protocolVersion}` };
    }
    if (!isStatelessProtocolVersion(meta.protocolVersion)) {
        return { code: ProtocolErrorCode.InvalidParams, message: `'_meta.protocolVersion' is not a stateless version` };
    }
    if (headerVersion !== null && headerVersion !== meta.protocolVersion) {
        return {
            code: ProtocolErrorCode.HeaderMismatch,
            message: `MCP-Protocol-Version header does not match _meta.${META_KEYS.protocolVersion}`
        };
    }
    if (meta.clientInfo === undefined) {
        return { code: ProtocolErrorCode.InvalidParams, message: `Missing required _meta.${META_KEYS.clientInfo}` };
    }
    if (meta.clientCapabilities === undefined) {
        return { code: ProtocolErrorCode.InvalidParams, message: `Missing required _meta.${META_KEYS.clientCapabilities}` };
    }
    return undefined;
}

function sseDispatch(
    handlers: StatelessHandlers,
    requests: ReadonlyArray<{ r: JSONRPCRequest; meta: ClientMeta } | { r: JSONRPCRequest; error: JSONRPCErrorResponse }>,
    req: Request,
    options?: StatelessHttpRequestOptions
): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const write = (m: JSONRPCMessage) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
    };
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
            void (async () => {
                // Dispatch in parallel; each request's notifications stream as they arrive.
                await Promise.all(
                    requests.map(async item => {
                        if ('error' in item) {
                            write(item.error);
                            return;
                        }
                        const response = await handlers.dispatch(item.r, {
                            signal: req.signal,
                            authInfo: options?.authInfo,
                            httpRequest: req,
                            meta: item.meta,
                            notify: write
                        });
                        write(response);
                    })
                );
                if (!closed) {
                    closed = true;
                    controller.close();
                }
            })().catch(error => {
                if (!closed) {
                    closed = true;
                    controller.error(error);
                }
            });
        },
        cancel() {
            closed = true;
        }
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function sseResponse(source: AsyncIterable<JSONRPCMessage>, opts: { signal?: AbortSignal; onCancel(): void }): Response {
    const encoder = new TextEncoder();
    let closed = false;
    const cancel = () => {
        if (closed) return;
        closed = true;
        opts.onCancel();
    };
    opts.signal?.addEventListener('abort', cancel, { once: true });
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let iteratorError: unknown;
            try {
                for await (const m of source) {
                    if (closed) break;
                    controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
                }
            } catch (error) {
                iteratorError = error;
            } finally {
                opts.signal?.removeEventListener('abort', cancel);
                // Always release the listener registration on stream end,
                // including when the for-await throws non-abort.
                if (!closed) {
                    closed = true;
                    opts.onCancel();
                    if (iteratorError === undefined) {
                        controller.close();
                    } else {
                        controller.error(iteratorError);
                    }
                }
            }
        },
        cancel
    });
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
};

function statusForCode(code: number): number {
    switch (code) {
        case ProtocolErrorCode.MethodNotFound: {
            return 404;
        }
        case ProtocolErrorCode.InvalidParams:
        case ProtocolErrorCode.InvalidRequest:
        case ProtocolErrorCode.ParseError:
        case ProtocolErrorCode.HeaderMismatch:
        case ProtocolErrorCode.MissingRequiredClientCapability: {
            return 400;
        }
        case ProtocolErrorCode.InternalError: {
            return 500;
        }
        default: {
            return 200;
        }
    }
}

async function readBoundedText(req: Request, max: number): Promise<string | undefined> {
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel();
            return undefined;
        }
        chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
    }
    return new TextDecoder().decode(buf);
}

/** Builds a JSON-RPC error response with the given HTTP status. @internal */
export function jsonError(status: number, code: number, message: string, id: unknown, headers?: Record<string, string>): Response {
    return Response.json(
        { jsonrpc: JSONRPC_VERSION, id, error: { code, message } },
        { status, headers: { 'Content-Type': 'application/json', ...headers } }
    );
}
