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
export declare class RedisSessionStore implements SessionStore {
    private readonly redis;
    private readonly keyPrefix;
    private readonly ttlSeconds;
    private readonly log;
    constructor(options: RedisSessionStoreOptions);
    /**
     * Get the Redis key for a session
     */
    private getKey;
    /**
     * Store session data in Redis
     */
    storeSession(sessionId: string, data: SessionData): Promise<void>;
    /**
     * Retrieve session data from Redis
     */
    getSession(sessionId: string): Promise<SessionData | null>;
    /**
     * Update session activity timestamp and refresh TTL
     */
    updateSessionActivity(sessionId: string): Promise<void>;
    /**
     * Delete a session from Redis
     */
    deleteSession(sessionId: string): Promise<void>;
    /**
     * Check if a session exists in Redis
     */
    sessionExists(sessionId: string): Promise<boolean>;
}
/**
 * In-Memory Session Store (for development/testing)
 *
 * NOT suitable for production multi-pod deployments!
 * Use RedisSessionStore or implement your own SessionStore for production.
 */
export declare class InMemorySessionStore implements SessionStore {
    private sessions;
    private readonly ttlMs;
    constructor(ttlSeconds?: number);
    storeSession(sessionId: string, data: SessionData): Promise<void>;
    getSession(sessionId: string): Promise<SessionData | null>;
    updateSessionActivity(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    sessionExists(sessionId: string): Promise<boolean>;
    private cleanup;
}
//# sourceMappingURL=redis.d.ts.map