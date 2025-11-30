/**
 * Redis Session Store Implementation
 *
 * This module provides a Redis-based implementation of the SessionStore interface
 * for distributed MCP server deployments.
 *
 * Usage:
 * ```typescript
 * import Redis from 'ioredis';
 * import { RedisSessionStore } from '@modelcontextprotocol/sdk/server/session-stores/redis.js';
 * import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
 *
 * const redis = new Redis({
 *   host: 'redis.example.com',
 *   port: 6379,
 *   password: 'your-password'
 * });
 *
 * const sessionStore = new RedisSessionStore({
 *   redis,
 *   keyPrefix: 'mcp:session:',
 *   ttlSeconds: 3600 // 1 hour
 * });
 *
 * const transport = new StreamableHTTPServerTransport({
 *   sessionIdGenerator: () => randomUUID(),
 *   sessionStore
 * });
 * ```
 */

import { SessionStore, SessionData } from '../streamableHttp.js';

/**
 * Generic Redis client interface
 * Compatible with ioredis, node-redis, and other Redis clients
 */
export interface RedisClient {
    get(key: string): Promise<string | null>;
    setex(key: string, seconds: number, value: string): Promise<string | 'OK'>;
    del(key: string | string[]): Promise<number>;
    exists(key: string | string[]): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
}

/**
 * Configuration options for RedisSessionStore
 */
export interface RedisSessionStoreOptions {
    /**
     * Redis client instance (ioredis, node-redis, or compatible)
     */
    redis: RedisClient;

    /**
     * Key prefix for session data in Redis
     * @default 'mcp:session:'
     */
    keyPrefix?: string;

    /**
     * Session TTL in seconds
     * @default 3600 (1 hour)
     */
    ttlSeconds?: number;

    /**
     * Optional callback for logging
     */
    onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void;
}

/**
 * Redis-based session store for distributed MCP deployments
 *
 * Features:
 * - Automatic TTL management with activity-based refresh
 * - Cross-pod session sharing
 * - Graceful handling of Redis connection issues
 */
export class RedisSessionStore implements SessionStore {
    private readonly redis: RedisClient;
    private readonly keyPrefix: string;
    private readonly ttlSeconds: number;
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void;

    constructor(options: RedisSessionStoreOptions) {
        this.redis = options.redis;
        this.keyPrefix = options.keyPrefix ?? 'mcp:session:';
        this.ttlSeconds = options.ttlSeconds ?? 3600;
        this.log = options.onLog ?? (() => {});
    }

    /**
     * Get the Redis key for a session
     */
    private getKey(sessionId: string): string {
        return `${this.keyPrefix}${sessionId}`;
    }

    /**
     * Store session data in Redis
     */
    async storeSession(sessionId: string, data: SessionData): Promise<void> {
        try {
            const key = this.getKey(sessionId);
            const serialized = JSON.stringify(data);
            await this.redis.setex(key, this.ttlSeconds, serialized);
            this.log('debug', `Session stored: ${sessionId}`);
        } catch (error) {
            this.log('error', `Failed to store session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Retrieve session data from Redis
     */
    async getSession(sessionId: string): Promise<SessionData | null> {
        try {
            const key = this.getKey(sessionId);
            const data = await this.redis.get(key);

            if (!data) {
                this.log('debug', `Session not found: ${sessionId}`);
                return null;
            }

            const parsed = JSON.parse(data) as SessionData;
            this.log('debug', `Session retrieved: ${sessionId}`);
            return parsed;
        } catch (error) {
            this.log('error', `Failed to get session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Update session activity timestamp and refresh TTL
     */
    async updateSessionActivity(sessionId: string): Promise<void> {
        try {
            const key = this.getKey(sessionId);
            const data = await this.redis.get(key);

            if (!data) {
                this.log('warn', `Cannot update activity for non-existent session: ${sessionId}`);
                return;
            }

            const parsed = JSON.parse(data) as SessionData;
            parsed.lastActivity = Date.now();

            await this.redis.setex(key, this.ttlSeconds, JSON.stringify(parsed));
            this.log('debug', `Session activity updated: ${sessionId}`);
        } catch (error) {
            this.log('error', `Failed to update session activity ${sessionId}:`, error);
            // Don't throw - activity update failures shouldn't break the request
        }
    }

    /**
     * Delete a session from Redis
     */
    async deleteSession(sessionId: string): Promise<void> {
        try {
            const key = this.getKey(sessionId);
            await this.redis.del(key);
            this.log('debug', `Session deleted: ${sessionId}`);
        } catch (error) {
            this.log('error', `Failed to delete session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Check if a session exists in Redis
     */
    async sessionExists(sessionId: string): Promise<boolean> {
        try {
            const key = this.getKey(sessionId);
            const exists = await this.redis.exists(key);
            return exists === 1;
        } catch (error) {
            this.log('error', `Failed to check session existence ${sessionId}:`, error);
            throw error;
        }
    }
}

/**
 * In-Memory Session Store (for development/testing)
 *
 * NOT suitable for production multi-pod deployments!
 * Use RedisSessionStore or implement your own SessionStore for production.
 */
export class InMemorySessionStore implements SessionStore {
    private sessions: Map<string, SessionData> = new Map();
    private readonly ttlMs: number;

    constructor(ttlSeconds: number = 3600) {
        this.ttlMs = ttlSeconds * 1000;

        // Cleanup expired sessions every minute
        setInterval(() => this.cleanup(), 60000);
    }

    async storeSession(sessionId: string, data: SessionData): Promise<void> {
        this.sessions.set(sessionId, data);
    }

    async getSession(sessionId: string): Promise<SessionData | null> {
        const data = this.sessions.get(sessionId);
        if (!data) return null;

        // Check if expired
        if (Date.now() - data.lastActivity > this.ttlMs) {
            this.sessions.delete(sessionId);
            return null;
        }

        return data;
    }

    async updateSessionActivity(sessionId: string): Promise<void> {
        const data = this.sessions.get(sessionId);
        if (data) {
            data.lastActivity = Date.now();
        }
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId);
    }

    async sessionExists(sessionId: string): Promise<boolean> {
        const data = await this.getSession(sessionId);
        return data !== null;
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [sessionId, data] of this.sessions) {
            if (now - data.lastActivity > this.ttlMs) {
                this.sessions.delete(sessionId);
            }
        }
    }
}
