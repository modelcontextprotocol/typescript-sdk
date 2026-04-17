import type { FetchLike, JSONRPCErrorResponse, JSONRPCNotification, JSONRPCRequest, JSONRPCResultResponse } from '@modelcontextprotocol/core';
import {
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCResultResponse,
    JSONRPCMessageSchema,
    normalizeHeaders,
    SdkError,
    SdkErrorCode
} from '@modelcontextprotocol/core';
import { EventSourceParserStream } from 'eventsource-parser/stream';

import type { ClientFetchOptions, ClientTransport } from './clientTransport.js';

export interface StreamableHttpReconnectionOptions {
    initialReconnectionDelay: number;
    maxReconnectionDelay: number;
    reconnectionDelayGrowFactor: number;
    maxRetries: number;
}

const DEFAULT_RECONNECT: StreamableHttpReconnectionOptions = {
    initialReconnectionDelay: 1000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 2
};

export type StreamableHttpClientTransportV2Options = {
    /**
     * Custom `fetch`. Auth composes here via `withOAuth(fetch)` middleware
     * instead of being baked into the transport.
     */
    fetch?: FetchLike;
    /** Extra headers/init merged into every request. */
    requestInit?: RequestInit;
    /** Reconnection backoff for resumable SSE responses. */
    reconnectionOptions?: StreamableHttpReconnectionOptions;
    /**
     * Seed session id for reconnecting to an existing session
     * (2025-11 stateful servers).
     */
    sessionId?: string;
    /** Seed protocol version header for reconnect-without-init. */
    protocolVersion?: string;
};

/**
 * Request-shaped Streamable HTTP client transport (Proposal 9). One POST per
 * {@linkcode fetch}; the response body may be JSON or an SSE stream. Progress
 * and other notifications are surfaced via {@linkcode ClientFetchOptions}
 * callbacks; the returned promise resolves with the terminal response.
 *
 * Auth retry is intentionally not implemented here. Compose via
 * `withOAuth(fetch)` and pass as {@linkcode StreamableHttpClientTransportV2Options.fetch}.
 *
 * The transport is stateful internally for 2025-11 compat: it captures
 * `mcp-session-id` from response headers and echoes it on subsequent requests.
 * That state is private; nothing on the {@linkcode ClientTransport} contract
 * exposes it.
 */
export class StreamableHttpClientTransportV2 implements ClientTransport {
    private _fetch: FetchLike;
    private _requestInit?: RequestInit;
    private _sessionId?: string;
    private _protocolVersion?: string;
    private _reconnect: StreamableHttpReconnectionOptions;
    private _abort = new AbortController();
    private _serverRetryMs?: number;

    constructor(
        private _url: URL,
        opts: StreamableHttpClientTransportV2Options = {}
    ) {
        this._fetch = opts.fetch ?? fetch;
        this._requestInit = opts.requestInit;
        this._sessionId = opts.sessionId;
        this._protocolVersion = opts.protocolVersion;
        this._reconnect = opts.reconnectionOptions ?? DEFAULT_RECONNECT;
    }

    get sessionId(): string | undefined {
        return this._sessionId;
    }
    setProtocolVersion(v: string): void {
        this._protocolVersion = v;
    }

    async fetch(request: JSONRPCRequest, opts: ClientFetchOptions = {}): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        return this._fetchOnce(request, opts, undefined, 0);
    }

    async notify(n: { method: string; params?: unknown }): Promise<void> {
        const headers = this._headers();
        headers.set('content-type', 'application/json');
        headers.set('accept', 'application/json, text/event-stream');
        const res = await this._fetch(this._url, {
            ...this._requestInit,
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', method: n.method, params: n.params }),
            signal: this._abort.signal
        });
        const sid = res.headers.get('mcp-session-id');
        if (sid) this._sessionId = sid;
        await res.text?.().catch(() => {});
        if (!res.ok && res.status !== 202) {
            throw new SdkError(SdkErrorCode.ClientHttpNotImplemented, `Notification POST failed: ${res.status}`, { status: res.status });
        }
    }

    async *subscribe(): AsyncIterable<JSONRPCNotification> {
        // 2026-06 messages/listen replaces the standalone GET stream. For now,
        // open a GET SSE for 2025-11 compat. Best-effort: 405 means unsupported.
        const headers = this._headers();
        headers.set('accept', 'text/event-stream');
        const res = await this._fetch(this._url, { ...this._requestInit, method: 'GET', headers, signal: this._abort.signal });
        if (res.status === 405 || !res.ok || !res.body) {
            await res.text?.().catch(() => {});
            return;
        }
        const reader = res.body
            .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)
            .pipeThrough(new EventSourceParserStream({ onRetry: ms => (this._serverRetryMs = ms) }))
            .getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) return;
                if (!value.data) continue;
                const msg = JSONRPCMessageSchema.parse(JSON.parse(value.data));
                if (isJSONRPCNotification(msg)) yield msg;
            }
        } finally {
            reader.releaseLock();
        }
    }

    async close(): Promise<void> {
        this._abort.abort();
    }

    /** Explicitly terminate a 2025-11 session via DELETE. */
    async terminateSession(): Promise<void> {
        if (!this._sessionId) return;
        const headers = this._headers();
        const res = await this._fetch(this._url, { ...this._requestInit, method: 'DELETE', headers, signal: this._abort.signal });
        await res.text?.().catch(() => {});
        if (!res.ok && res.status !== 405) {
            throw new SdkError(SdkErrorCode.ClientHttpFailedToTerminateSession, `Failed to terminate session: ${res.statusText}`, {
                status: res.status
            });
        }
        this._sessionId = undefined;
    }

    private _headers(): Headers {
        const h: Record<string, string> = {};
        if (this._sessionId) h['mcp-session-id'] = this._sessionId;
        if (this._protocolVersion) h['mcp-protocol-version'] = this._protocolVersion;
        return new Headers({ ...h, ...normalizeHeaders(this._requestInit?.headers) });
    }

    private _delay(attempt: number): number {
        if (this._serverRetryMs !== undefined) return this._serverRetryMs;
        const { initialReconnectionDelay: i, reconnectionDelayGrowFactor: g, maxReconnectionDelay: m } = this._reconnect;
        return Math.min(i * Math.pow(g, attempt), m);
    }

    private _link(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
        if (!a) return b;
        if (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
            return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([a, b]);
        }
        const c = new AbortController();
        const onA = () => c.abort(a.reason);
        const onB = () => c.abort(b.reason);
        if (a.aborted) c.abort(a.reason);
        else a.addEventListener('abort', onA, { once: true });
        if (b.aborted) c.abort(b.reason);
        else b.addEventListener('abort', onB, { once: true });
        return c.signal;
    }

    private async _fetchOnce(
        request: JSONRPCRequest,
        opts: ClientFetchOptions,
        lastEventId: string | undefined,
        attempt: number
    ): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        const headers = this._headers();
        headers.set('content-type', 'application/json');
        headers.set('accept', 'application/json, text/event-stream');
        if (lastEventId) headers.set('last-event-id', lastEventId);
        const signal = this._link(opts.signal, this._abort.signal);
        const isResume = lastEventId !== undefined;
        const init: RequestInit = isResume
            ? { ...this._requestInit, method: 'GET', headers, signal }
            : { ...this._requestInit, method: 'POST', headers, body: JSON.stringify(request), signal };
        const res = await this._fetch(this._url, init);
        const sid = res.headers.get('mcp-session-id');
        if (sid) this._sessionId = sid;
        if (!res.ok) {
            const text = await res.text?.().catch(() => null);
            throw new SdkError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint (HTTP ${res.status}): ${text}`, {
                status: res.status,
                text
            });
        }
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('text/event-stream')) {
            return this._readSse(res, request, opts, attempt);
        }
        if (ct.includes('application/json')) {
            const data = await res.json();
            const messages = Array.isArray(data) ? data : [data];
            let terminal: JSONRPCResultResponse | JSONRPCErrorResponse | undefined;
            for (const m of messages) {
                const msg = JSONRPCMessageSchema.parse(m);
                if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) terminal = msg;
                else if (isJSONRPCNotification(msg)) this._routeNotification(msg, opts);
            }
            if (!terminal) {
                throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, 'JSON response contained no terminal response');
            }
            return terminal;
        }
        await res.text?.().catch(() => {});
        throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, `Unexpected content type: ${ct}`, { contentType: ct });
    }

    private async _readSse(
        res: Response,
        request: JSONRPCRequest,
        opts: ClientFetchOptions,
        attempt: number
    ): Promise<JSONRPCResultResponse | JSONRPCErrorResponse> {
        if (!res.body) throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, 'SSE response has no body');
        let lastEventId: string | undefined;
        let primed = false;
        const reader = res.body
            .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)
            .pipeThrough(new EventSourceParserStream({ onRetry: ms => (this._serverRetryMs = ms) }))
            .getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value.id) {
                    lastEventId = value.id;
                    primed = true;
                }
                if (!value.data) continue;
                if (value.event && value.event !== 'message') continue;
                const msg = JSONRPCMessageSchema.parse(JSON.parse(value.data));
                if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) {
                    return msg;
                }
                if (isJSONRPCNotification(msg)) this._routeNotification(msg, opts);
            }
        } catch {
            // fallthrough to resume below
        } finally {
            try {
                reader.releaseLock();
            } catch {
                /* noop */
            }
        }
        if (primed && attempt < this._reconnect.maxRetries && !this._abort.signal.aborted && !opts.signal?.aborted) {
            await new Promise(r => setTimeout(r, this._delay(attempt)));
            return this._fetchOnce(request, opts, lastEventId, attempt + 1);
        }
        throw new SdkError(SdkErrorCode.ClientHttpFailedToOpenStream, 'SSE stream ended without a terminal response');
    }

    private _routeNotification(msg: JSONRPCNotification, opts: ClientFetchOptions): void {
        if (msg.method === 'notifications/progress' && opts.onprogress) {
            const { progressToken: _t, ...progress } = (msg.params ?? {}) as Record<string, unknown>;
            opts.onprogress(progress as never);
            return;
        }
        opts.onnotification?.(msg);
    }
}

type ReadableWritablePair<O, I> = { readable: ReadableStream<O>; writable: WritableStream<I> };
