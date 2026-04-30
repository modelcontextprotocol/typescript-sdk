import type { ClientCapabilities, JSONRPCMessage } from '@modelcontextprotocol/core';
import { isInitializeRequest } from '@modelcontextprotocol/core';

/**
 * Options for {@linkcode SessionCompat}.
 */
export interface SessionCompatOptions {
    /**
     * Function that generates a session ID. SHOULD be globally unique and cryptographically secure
     * (e.g., a securely generated UUID).
     *
     * @default `() => crypto.randomUUID()`
     */
    sessionIdGenerator?: () => string;

    /**
     * Maximum number of concurrent sessions to retain. New `initialize` requests beyond this cap
     * are rejected with HTTP 503 + `Retry-After`. Idle sessions are evicted LRU when at the cap.
     *
     * @default 10000
     */
    maxSessions?: number;

    /**
     * Sessions idle (no request received) for longer than this are evicted on the next sweep.
     *
     * @default 30 * 60_000 (30 minutes)
     */
    idleTtlMs?: number;

    /**
     * Suggested `Retry-After` value (seconds) returned with 503 when at {@linkcode maxSessions}.
     *
     * @default 30
     */
    retryAfterSeconds?: number;

    /** Called when a new session is minted. */
    onsessioninitialized?: (sessionId: string) => void | Promise<void>;

    /** Called when a session is deleted (via DELETE) or evicted. */
    onsessionclosed?: (sessionId: string) => void | Promise<void>;

    /**
     * When `true`, this instance allows at most one session: a second `initialize`
     * is rejected with "Server already initialized". Matches the per-transport-instance
     * v1 behaviour where each `WebStandardStreamableHTTPServerTransport` holds one session.
     *
     * @default false
     */
    singleSession?: boolean;

    /** Called for validation failures (re-init, missing/unknown session header). */
    onerror?: (error: Error) => void;
}

interface SessionEntry {
    createdAt: number;
    lastSeen: number;
    /** Standalone GET subscription stream controller, if one is open. */
    sseController?: ReadableStreamDefaultController<Uint8Array>;
    /** Protocol version requested by the client in `initialize.params.protocolVersion`. */
    protocolVersion?: string;
    /** Capabilities the client declared in `initialize.params.capabilities`. */
    clientCapabilities?: ClientCapabilities;
}

/** Result of {@linkcode SessionCompat.validate}. */
export type SessionValidation = { ok: true; sessionId: string | undefined; isInitialize: boolean } | { ok: false; response: Response };

function jsonError(status: number, code: number, message: string, headers?: Record<string, string>): Response {
    return Response.json(
        { jsonrpc: '2.0', error: { code, message }, id: null },
        { status, headers: { 'Content-Type': 'application/json', ...headers } }
    );
}

/**
 * Bounded, in-memory `mcp-session-id` lifecycle for the pre-2026-06 stateful Streamable HTTP
 * protocol. One instance is shared across all requests to a given `shttpHandler`.
 *
 * Sessions are minted when an `initialize` request arrives and validated on every subsequent
 * request via the `mcp-session-id` header. Storage is LRU with {@linkcode SessionCompatOptions.maxSessions}
 * cap and {@linkcode SessionCompatOptions.idleTtlMs} idle eviction.
 */
export class SessionCompat {
    private readonly _sessions = new Map<string, SessionEntry>();
    private readonly _generate: () => string;
    private readonly _maxSessions: number;
    private readonly _idleTtlMs: number;
    private readonly _retryAfterSeconds: number;
    private readonly _onsessioninitialized?: (sessionId: string) => void | Promise<void>;
    private readonly _onsessionclosed?: (sessionId: string) => void | Promise<void>;
    private readonly _singleSession: boolean;
    private readonly _onerror?: (error: Error) => void;

    constructor(options: SessionCompatOptions = {}) {
        this._generate = options.sessionIdGenerator ?? (() => crypto.randomUUID());
        this._maxSessions = options.maxSessions ?? 10_000;
        this._idleTtlMs = options.idleTtlMs ?? 30 * 60_000;
        this._retryAfterSeconds = options.retryAfterSeconds ?? 30;
        this._onsessioninitialized = options.onsessioninitialized;
        this._onsessionclosed = options.onsessionclosed;
        this._singleSession = options.singleSession ?? false;
        this._onerror = options.onerror;
    }

    /**
     * Validates the `mcp-session-id` header for a parsed POST body. If the body contains an
     * `initialize` request, mints a new session instead. Ported from
     * `WebStandardStreamableHTTPServerTransport.validateSession` + the initialize-detection
     * block of `handlePostRequest`.
     */
    async validate(req: Request, messages: JSONRPCMessage[]): Promise<SessionValidation> {
        const isInit = messages.some(m => isInitializeRequest(m));

        if (isInit) {
            if (messages.length > 1) {
                this._onerror?.(new Error('Invalid Request: Only one initialization request is allowed'));
                return {
                    ok: false,
                    response: jsonError(400, -32_600, 'Invalid Request: Only one initialization request is allowed')
                };
            }
            if (this._singleSession && this._sessions.size > 0) {
                this._onerror?.(new Error('Invalid Request: Server already initialized'));
                return {
                    ok: false,
                    response: jsonError(400, -32_600, 'Invalid Request: Server already initialized')
                };
            }
            this._evictIdle();
            if (this._sessions.size >= this._maxSessions) {
                this._evictOldest();
            }
            if (this._sessions.size >= this._maxSessions) {
                return {
                    ok: false,
                    response: jsonError(503, -32_000, 'Server at session capacity', {
                        'Retry-After': String(this._retryAfterSeconds)
                    })
                };
            }
            const id = this._generate();
            const now = Date.now();
            const initMsg = messages.find(m => isInitializeRequest(m));
            const initParams = initMsg && isInitializeRequest(initMsg) ? initMsg.params : undefined;
            this._sessions.set(id, {
                createdAt: now,
                lastSeen: now,
                protocolVersion: initParams?.protocolVersion,
                clientCapabilities: initParams?.capabilities
            });
            try {
                await Promise.resolve(this._onsessioninitialized?.(id));
            } catch (error) {
                this._sessions.delete(id);
                throw error;
            }
            return { ok: true, sessionId: id, isInitialize: true };
        }

        return this.validateHeader(req);
    }

    /**
     * Validates the `mcp-session-id` header without inspecting a body (for GET/DELETE).
     */
    validateHeader(req: Request): SessionValidation {
        if (this._singleSession && this._sessions.size === 0) {
            this._onerror?.(new Error('Bad Request: Server not initialized'));
            return { ok: false, response: jsonError(400, -32_000, 'Bad Request: Server not initialized') };
        }
        const headerId = req.headers.get('mcp-session-id');
        if (!headerId) {
            this._onerror?.(new Error('Bad Request: Mcp-Session-Id header is required'));
            return {
                ok: false,
                response: jsonError(400, -32_000, 'Bad Request: Mcp-Session-Id header is required')
            };
        }
        const entry = this._sessions.get(headerId);
        if (!entry) {
            this._onerror?.(new Error('Session not found'));
            return { ok: false, response: jsonError(404, -32_001, 'Session not found') };
        }
        entry.lastSeen = Date.now();
        // Re-insert to maintain Map iteration order as LRU.
        this._sessions.delete(headerId);
        this._sessions.set(headerId, entry);
        return { ok: true, sessionId: headerId, isInitialize: false };
    }

    /** Deletes a session (via DELETE request). */
    async delete(sessionId: string): Promise<void> {
        const entry = this._sessions.get(sessionId);
        if (!entry) return;
        try {
            entry.sseController?.close();
        } catch {
            // Already closed.
        }
        this._sessions.delete(sessionId);
        await Promise.resolve(this._onsessionclosed?.(sessionId));
    }

    /** Protocol version the client requested in `initialize` for this session, if known. */
    negotiatedVersion(sessionId: string): string | undefined {
        return this._sessions.get(sessionId)?.protocolVersion;
    }

    /** Capabilities the client declared in `initialize` for this session, if known. */
    clientCapabilities(sessionId: string): ClientCapabilities | undefined {
        return this._sessions.get(sessionId)?.clientCapabilities;
    }

    /** Returns true if a standalone GET stream is already open for this session. */
    hasStandaloneStream(sessionId: string): boolean {
        return this._sessions.get(sessionId)?.sseController !== undefined;
    }

    /**
     * Registers the open standalone GET stream controller for this session. Closes any
     * previously-registered controller so a `Last-Event-ID` reconnect supersedes it
     * cleanly instead of leaking the prior stream.
     */
    setStandaloneStream(sessionId: string, controller: ReadableStreamDefaultController<Uint8Array> | undefined): void {
        const entry = this._sessions.get(sessionId);
        if (!entry) return;
        if (entry.sseController && entry.sseController !== controller) {
            try {
                entry.sseController.close();
            } catch {
                // Already closed.
            }
        }
        entry.sseController = controller;
    }

    /**
     * Clears the standalone stream registration only if `owner` is still the registered controller.
     * Guards against a stale `cancel` callback (from a superseded reconnect) clearing the new stream.
     */
    clearStandaloneStream(sessionId: string, owner: ReadableStreamDefaultController<Uint8Array>): void {
        const entry = this._sessions.get(sessionId);
        if (entry?.sseController === owner) entry.sseController = undefined;
    }

    /** Closes the standalone GET stream for this session if one is open. */
    closeStandaloneStream(sessionId: string): void {
        const entry = this._sessions.get(sessionId);
        try {
            entry?.sseController?.close();
        } catch {
            // Already closed.
        }
        if (entry) entry.sseController = undefined;
    }

    /** Number of live sessions. */
    get size(): number {
        return this._sessions.size;
    }

    private _evict(id: string): void {
        const entry = this._sessions.get(id);
        try {
            entry?.sseController?.close();
        } catch {
            // Already closed.
        }
        this._sessions.delete(id);
        void Promise.resolve(this._onsessionclosed?.(id));
    }

    private _evictIdle(): void {
        const cutoff = Date.now() - this._idleTtlMs;
        for (const [id, entry] of this._sessions) {
            if (entry.lastSeen < cutoff) this._evict(id);
        }
    }

    private _evictOldest(): void {
        const oldest = this._sessions.keys().next();
        if (!oldest.done) this._evict(oldest.value);
    }
}
