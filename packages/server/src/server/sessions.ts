/**
 * Session Management Abstraction
 *
 * Provides a SessionStore interface and implementations for managing
 * server session state. This replaces the manual session map management
 * patterns seen across examples.
 */

/**
 * Session lifecycle event callbacks
 */
export interface SessionStoreEvents<T> {
    /**
     * Called when a new session is created
     */
    onSessionCreated?: (sessionId: string, data: T) => void;

    /**
     * Called when a session is destroyed
     */
    onSessionDestroyed?: (sessionId: string) => void;

    /**
     * Called when session data is updated
     */
    onSessionUpdated?: (sessionId: string, data: T) => void;
}

/**
 * Interface for session storage implementations.
 *
 * @template T - The type of session data
 */
export interface SessionStore<T = unknown> {
    /**
     * Gets the session data for a given session ID.
     *
     * @param sessionId - The session identifier
     * @returns The session data or undefined if not found
     */
    get(sessionId: string): T | undefined;

    /**
     * Sets the session data for a given session ID.
     * Creates a new session if it doesn't exist.
     *
     * @param sessionId - The session identifier
     * @param data - The session data to store
     */
    set(sessionId: string, data: T): void;

    /**
     * Deletes a session.
     *
     * @param sessionId - The session identifier
     * @returns true if the session was deleted, false if it didn't exist
     */
    delete(sessionId: string): boolean;

    /**
     * Checks if a session exists.
     *
     * @param sessionId - The session identifier
     * @returns true if the session exists
     */
    has(sessionId: string): boolean;

    /**
     * Gets the number of active sessions.
     */
    size(): number;

    /**
     * Gets all session IDs.
     */
    keys(): string[];

    /**
     * Clears all sessions.
     */
    clear(): void;
}

/**
 * Options for InMemorySessionStore
 */
export interface InMemorySessionStoreOptions<T> {
    /**
     * Maximum number of sessions to store.
     * When exceeded, the oldest session will be evicted.
     * Default: unlimited
     */
    maxSessions?: number;

    /**
     * Session timeout in milliseconds.
     * Sessions older than this will be automatically cleaned up.
     * Default: no timeout
     */
    sessionTimeout?: number;

    /**
     * Interval for checking expired sessions in milliseconds.
     * Default: 60000 (1 minute)
     */
    cleanupInterval?: number;

    /**
     * Event callbacks
     */
    events?: SessionStoreEvents<T>;
}

/**
 * Internal session entry with metadata
 */
interface SessionEntry<T> {
    data: T;
    createdAt: number;
    lastAccessedAt: number;
}

/**
 * In-memory implementation of SessionStore.
 *
 * Features:
 * - Optional maximum session limit with LRU eviction
 * - Optional session timeout with automatic cleanup
 * - Lifecycle event callbacks
 *
 * @template T - The type of session data
 */
export class InMemorySessionStore<T = unknown> implements SessionStore<T> {
    private _sessions = new Map<string, SessionEntry<T>>();
    private _options: InMemorySessionStoreOptions<T>;
    private _cleanupTimer?: ReturnType<typeof setInterval>;

    constructor(options: InMemorySessionStoreOptions<T> = {}) {
        this._options = options;

        // Set up automatic cleanup if timeout is configured
        if (options.sessionTimeout && options.sessionTimeout > 0) {
            const interval = options.cleanupInterval ?? 60_000;
            this._cleanupTimer = setInterval(() => {
                this._cleanupExpiredSessions();
            }, interval);

            // Prevent timer from keeping process alive
            if (typeof this._cleanupTimer.unref === 'function') {
                this._cleanupTimer.unref();
            }
        }
    }

    /**
     * Gets the session data for a given session ID.
     * Updates the last accessed time on access.
     */
    get(sessionId: string): T | undefined {
        const entry = this._sessions.get(sessionId);
        if (!entry) {
            return undefined;
        }

        // Check if expired
        if (this._isExpired(entry)) {
            this.delete(sessionId);
            return undefined;
        }

        // Update last accessed time
        entry.lastAccessedAt = Date.now();
        return entry.data;
    }

    /**
     * Sets the session data for a given session ID.
     * Creates a new session if it doesn't exist.
     */
    set(sessionId: string, data: T): void {
        const existing = this._sessions.get(sessionId);
        const now = Date.now();

        if (existing) {
            // Update existing session
            existing.data = data;
            existing.lastAccessedAt = now;
            this._options.events?.onSessionUpdated?.(sessionId, data);
        } else {
            // Create new session
            // Check max sessions limit
            if (this._options.maxSessions && this._sessions.size >= this._options.maxSessions) {
                this._evictOldestSession();
            }

            this._sessions.set(sessionId, {
                data,
                createdAt: now,
                lastAccessedAt: now
            });
            this._options.events?.onSessionCreated?.(sessionId, data);
        }
    }

    /**
     * Deletes a session.
     */
    delete(sessionId: string): boolean {
        const deleted = this._sessions.delete(sessionId);
        if (deleted) {
            this._options.events?.onSessionDestroyed?.(sessionId);
        }
        return deleted;
    }

    /**
     * Checks if a session exists.
     */
    has(sessionId: string): boolean {
        const entry = this._sessions.get(sessionId);
        if (!entry) {
            return false;
        }

        // Check if expired
        if (this._isExpired(entry)) {
            this.delete(sessionId);
            return false;
        }

        return true;
    }

    /**
     * Gets the number of active sessions.
     */
    size(): number {
        return this._sessions.size;
    }

    /**
     * Gets all session IDs.
     */
    keys(): string[] {
        return [...this._sessions.keys()];
    }

    /**
     * Clears all sessions.
     */
    clear(): void {
        const sessionIds = this.keys();
        for (const sessionId of sessionIds) {
            this.delete(sessionId);
        }
    }

    /**
     * Stops the cleanup timer.
     * Call this when the store is no longer needed.
     */
    dispose(): void {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = undefined;
        }
    }

    /**
     * Checks if a session entry is expired.
     */
    private _isExpired(entry: SessionEntry<T>): boolean {
        if (!this._options.sessionTimeout) {
            return false;
        }
        const age = Date.now() - entry.lastAccessedAt;
        return age > this._options.sessionTimeout;
    }

    /**
     * Evicts the oldest session (by last access time).
     */
    private _evictOldestSession(): void {
        let oldestId: string | undefined;
        let oldestTime = Infinity;

        for (const [id, entry] of this._sessions) {
            if (entry.lastAccessedAt < oldestTime) {
                oldestTime = entry.lastAccessedAt;
                oldestId = id;
            }
        }

        if (oldestId) {
            this.delete(oldestId);
        }
    }

    /**
     * Cleans up expired sessions.
     */
    private _cleanupExpiredSessions(): void {
        for (const [sessionId, entry] of this._sessions) {
            if (this._isExpired(entry)) {
                this.delete(sessionId);
            }
        }
    }
}

/**
 * Creates a new in-memory session store.
 *
 * @example
 * ```typescript
 * const sessionStore = createSessionStore<{ userId: string }>({
 *   sessionTimeout: 30 * 60 * 1000, // 30 minutes
 *   maxSessions: 1000,
 *   events: {
 *     onSessionCreated: (id) => console.log(`Session created: ${id}`),
 *     onSessionDestroyed: (id) => console.log(`Session destroyed: ${id}`),
 *   }
 * });
 * ```
 */
export function createSessionStore<T = unknown>(options?: InMemorySessionStoreOptions<T>): InMemorySessionStore<T> {
    return new InMemorySessionStore<T>(options);
}

/**
 * Session ID generator using crypto.randomUUID.
 * Falls back to Math.random if crypto is not available.
 */
export function generateSessionId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replaceAll(/[xy]/g, c => {
        const r = Math.trunc(Math.random() * 16);
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
