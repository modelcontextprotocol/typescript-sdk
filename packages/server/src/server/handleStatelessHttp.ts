import type { AuthInfo, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core';
import {
    isJSONRPCNotification,
    isJSONRPCRequest,
    JSONRPCMessageSchema,
    META_KEYS,
    ProtocolErrorCode,
    STATEFUL_PROTOCOL_VERSIONS,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import type { McpServer } from './mcp.js';
import { hostHeaderValidationResponse } from './middleware/hostHeaderValidation.js';

/** A `(Request) => Response` handler for any fetch-compatible runtime. */
export type FetchHandler = (req: Request, extra?: HttpRequestExtra) => Promise<Response>;

/**
 * Factory that builds a fresh `McpServer`. Called once per request. Hoist
 * cross-instance state (db pools, caches) outside the factory so all instances
 * share it.
 */
export type CreateMcpServer = () => McpServer;

/** Per-request extras supplied by framework adapters (parsed auth, pre-consumed body). */
export interface HttpRequestExtra {
    authInfo?: AuthInfo;
    /** Pre-parsed body, when the framework has already consumed `req.body`. */
    parsedBody?: unknown;
}

export interface HandleStatelessHttpOptions {
    /**
     * DNS rebinding protection: reject requests whose `Host` header is not in
     * this list. Hostnames only (no port). When unset, no Host check is
     * performed (assume an upstream proxy enforces it).
     */
    allowedHosts?: string[];
}

/**
 * HTTP entry for the SEP-2575 stateless model. Serves 2026-06+ clients only:
 * each request carries its full client state in `_meta`, the server is built
 * fresh per request from `createMcpServer`, and there is no session map.
 *
 * Requires `MCP-Protocol-Version` header and `_meta.protocolVersion` to both be
 * present, agree, and name a supported stateless-model version. Anything else
 * is rejected with 400 `InvalidParams`.
 *
 * Only POST is accepted (405 otherwise). The response is SSE (notifications
 * then final response) when the client accepts `text/event-stream`, else a
 * single JSON body. `-32601 MethodNotFound` maps to HTTP 404 for single
 * non-batch responses.
 *
 * To serve pre-2026 clients alongside, dispatch on the `MCP-Protocol-Version`
 * header before this handler and route legacy traffic to a sessionful
 * transport. SDK-managed legacy routing is a separate follow-up.
 *
 * @example
 * ```ts
 * function createMcpServer() {
 *   const mcp = new McpServer({ name: 'x', version: '1.0' });
 *   mcp.tool('echo', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text }] }));
 *   return mcp;
 * }
 * const handler = handleStatelessHttp(createMcpServer);
 * // Hono: app.all('/mcp', c => handler(c.req.raw));
 * ```
 */
export function handleStatelessHttp(createMcpServer: CreateMcpServer, options?: HandleStatelessHttpOptions): FetchHandler {
    return async (req, extra) => {
        if (options?.allowedHosts) {
            const hostReject = hostHeaderValidationResponse(req, options.allowedHosts);
            if (hostReject) return hostReject;
        }
        if (req.method !== 'POST') {
            return jsonError(405, -32_000, 'Method Not Allowed (stateless server accepts POST only)', null, { Allow: 'POST' });
        }

        const parsed = await parsePostBody(req, extra);
        if (!parsed.ok) return parsed.response;
        const first = parsed.messages[0];
        const id = (first && 'id' in first ? first.id : null) ?? null;

        const versionCheck = validateProtocolVersion(req, first);
        if (versionCheck) {
            return jsonError(400, ProtocolErrorCode.InvalidParams, versionCheck.message, id, undefined, versionCheck.data);
        }

        const missing = missingRequiredMeta(first);
        if (missing) {
            return jsonError(400, ProtocolErrorCode.InvalidParams, `Invalid params: missing required _meta field '${missing}'`, id);
        }

        if (parsed.requests.length === 0) return new Response(null, { status: 202 });

        const server = createMcpServer().server;
        const accept = req.headers.get('accept') ?? '';
        const wantsJson = accept.includes('application/json') && !accept.includes('text/event-stream');
        const httpExtra = { authInfo: extra?.authInfo, request: req };

        if (wantsJson) {
            const out = await Promise.all(parsed.requests.map(r => server.handleStatelessRequest(r, { extra: httpExtra })));
            const body = !parsed.isBatch && out.length === 1 ? out[0] : out;
            // -32601 MethodNotFound MUST be HTTP 404 (single non-batch only).
            const single = !parsed.isBatch && out.length === 1 ? out[0] : undefined;
            const status = single && 'error' in single && single.error.code === ProtocolErrorCode.MethodNotFound ? 404 : 200;
            return Response.json(body, { status });
        }

        const encoder = new TextEncoder();
        const aborts: AbortController[] = [];
        const readable = new ReadableStream<Uint8Array>({
            start(controller) {
                const write = (m: JSONRPCMessage) => controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
                void (async () => {
                    try {
                        await Promise.all(
                            parsed.requests.map(async r => {
                                const ctrl = new AbortController();
                                aborts.push(ctrl);
                                const resp = await server.handleStatelessRequest(r, {
                                    extra: httpExtra,
                                    signal: ctrl.signal,
                                    onNotification: n => {
                                        if (!ctrl.signal.aborted) write(n);
                                    }
                                });
                                if (!ctrl.signal.aborted) write(resp);
                            })
                        );
                    } finally {
                        try {
                            controller.close();
                        } catch {
                            // already closed
                        }
                    }
                })();
            },
            cancel() {
                for (const c of aborts) c.abort(new Error('Client closed SSE stream'));
            }
        });
        return new Response(readable, { status: 200, headers: { ...SSE_HEADERS } });
    };
}

const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
} as const;

/**
 * Required `_meta` subfields for a stateless-model request. `protocolVersion`
 * is checked by {@linkcode validateProtocolVersion}; this checks the rest.
 */
const REQUIRED_META_FIELDS = [META_KEYS.clientInfo, META_KEYS.clientCapabilities] as const;

function missingRequiredMeta(first: JSONRPCMessage | undefined): string | undefined {
    if (!isJSONRPCRequest(first) && !isJSONRPCNotification(first)) return META_KEYS.clientInfo;
    const meta = first.params?._meta;
    if (!meta) return META_KEYS.clientInfo;
    for (const k of REQUIRED_META_FIELDS) {
        if (meta[k] === undefined) return k;
    }
    return undefined;
}

/**
 * Validates that the `MCP-Protocol-Version` header and the request's
 * `_meta.protocolVersion` are both present, agree, and name a supported
 * stateless-model version. Returns the rejection details, or `undefined` if
 * the request is valid.
 */
function validateProtocolVersion(
    req: Request,
    first: JSONRPCMessage | undefined
): { message: string; data?: Record<string, unknown> } | undefined {
    const fromHeader = req.headers.get('mcp-protocol-version');
    const fromMeta =
        isJSONRPCRequest(first) || isJSONRPCNotification(first)
            ? (first.params?._meta?.[META_KEYS.protocolVersion] as string | undefined)
            : undefined;

    if (fromMeta === undefined) {
        return { message: `Invalid params: missing required _meta field '${META_KEYS.protocolVersion}'` };
    }
    if (!fromHeader) {
        return { message: 'Invalid Request: MCP-Protocol-Version header is required' };
    }
    if (fromHeader !== fromMeta) {
        return {
            message: `Invalid Request: MCP-Protocol-Version header ('${fromHeader}') must match _meta.protocolVersion ('${fromMeta}')`
        };
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(fromMeta) || (STATEFUL_PROTOCOL_VERSIONS as readonly string[]).includes(fromMeta)) {
        return {
            message: `Unsupported protocol version: '${fromMeta}'.`,
            data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: fromMeta }
        };
    }
    return undefined;
}

const BodySchema = z.union([JSONRPCMessageSchema, z.array(JSONRPCMessageSchema)]);

type ParsedBody =
    | { ok: true; isBatch: boolean; messages: JSONRPCMessage[]; requests: JSONRPCRequest[] }
    | { ok: false; response: Response };

async function parsePostBody(req: Request, extra?: HttpRequestExtra): Promise<ParsedBody> {
    const accept = req.headers.get('accept') ?? '';
    if (!accept.includes('text/event-stream') && !accept.includes('application/json')) {
        return {
            ok: false,
            response: jsonError(406, -32_000, 'Not Acceptable: client must accept text/event-stream or application/json')
        };
    }
    const ct = req.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
        return { ok: false, response: jsonError(415, -32_000, 'Unsupported Media Type: Content-Type must be application/json') };
    }
    let raw: unknown;
    try {
        raw = extra?.parsedBody ?? (await req.json());
    } catch (error) {
        return {
            ok: false,
            response: jsonError(400, -32_700, `Parse error: ${error instanceof Error ? error.message : String(error)}`)
        };
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
        return { ok: false, response: jsonError(400, -32_600, `Invalid Request: ${parsed.error.message}`) };
    }
    const isBatch = Array.isArray(parsed.data);
    const messages = isBatch ? (parsed.data as JSONRPCMessage[]) : [parsed.data as JSONRPCMessage];
    const requests = messages.filter(m => isJSONRPCRequest(m));
    return { ok: true, isBatch, messages, requests };
}

function jsonError(
    status: number,
    code: number,
    message: string,
    id: JSONRPCRequest['id'] | null = null,
    headers?: Record<string, string>,
    data?: Record<string, unknown>
): Response {
    return Response.json({ jsonrpc: '2.0', id, error: { code, message, ...(data && { data }) } }, { status, ...(headers && { headers }) });
}
