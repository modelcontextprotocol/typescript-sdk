"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemorySessionStore = exports.RedisSessionStore = void 0;
/**
 * Redis-based session store for distributed MCP deployments
 *
 * Features:
 * - Automatic TTL management with activity-based refresh
 * - Cross-pod session sharing
 * - Graceful handling of Redis connection issues
 */
class RedisSessionStore {
    constructor(options) {
        var _a, _b, _c;
        this.redis = options.redis;
        this.keyPrefix = (_a = options.keyPrefix) !== null && _a !== void 0 ? _a : 'mcp:session:';
        this.ttlSeconds = (_b = options.ttlSeconds) !== null && _b !== void 0 ? _b : 3600;
        this.log = (_c = options.onLog) !== null && _c !== void 0 ? _c : (() => { });
    }
    /**
     * Get the Redis key for a session
     */
    getKey(sessionId) {
        return `${this.keyPrefix}${sessionId}`;
    }
    /**
     * Store session data in Redis
     */
    async storeSession(sessionId, data) {
        try {
            const key = this.getKey(sessionId);
            const serialized = JSON.stringify(data);
            await this.redis.setex(key, this.ttlSeconds, serialized);
            this.log('debug', `Session stored: ${sessionId}`);
        }
        catch (error) {
            this.log('error', `Failed to store session ${sessionId}:`, error);
            throw error;
        }
    }
    /**
     * Retrieve session data from Redis
     */
    async getSession(sessionId) {
        try {
            const key = this.getKey(sessionId);
            const data = await this.redis.get(key);
            if (!data) {
                this.log('debug', `Session not found: ${sessionId}`);
                return null;
            }
            const parsed = JSON.parse(data);
            this.log('debug', `Session retrieved: ${sessionId}`);
            return parsed;
        }
        catch (error) {
            this.log('error', `Failed to get session ${sessionId}:`, error);
            throw error;
        }
    }
    /**
     * Update session activity timestamp and refresh TTL
     */
    async updateSessionActivity(sessionId) {
        try {
            const key = this.getKey(sessionId);
            const data = await this.redis.get(key);
            if (!data) {
                this.log('warn', `Cannot update activity for non-existent session: ${sessionId}`);
                return;
            }
            const parsed = JSON.parse(data);
            parsed.lastActivity = Date.now();
            await this.redis.setex(key, this.ttlSeconds, JSON.stringify(parsed));
            this.log('debug', `Session activity updated: ${sessionId}`);
        }
        catch (error) {
            this.log('error', `Failed to update session activity ${sessionId}:`, error);
            // Don't throw - activity update failures shouldn't break the request
        }
    }
    /**
     * Delete a session from Redis
     */
    async deleteSession(sessionId) {
        try {
            const key = this.getKey(sessionId);
            await this.redis.del(key);
            this.log('debug', `Session deleted: ${sessionId}`);
        }
        catch (error) {
            this.log('error', `Failed to delete session ${sessionId}:`, error);
            throw error;
        }
    }
    /**
     * Check if a session exists in Redis
     */
    async sessionExists(sessionId) {
        try {
            const key = this.getKey(sessionId);
            const exists = await this.redis.exists(key);
            return exists === 1;
        }
        catch (error) {
            this.log('error', `Failed to check session existence ${sessionId}:`, error);
            throw error;
        }
    }
}
exports.RedisSessionStore = RedisSessionStore;
/**
 * In-Memory Session Store (for development/testing)
 *
 * NOT suitable for production multi-pod deployments!
 * Use RedisSessionStore or implement your own SessionStore for production.
 */
class InMemorySessionStore {
    constructor(ttlSeconds = 3600) {
        this.sessions = new Map();
        this.ttlMs = ttlSeconds * 1000;
        // Cleanup expired sessions every minute
        setInterval(() => this.cleanup(), 60000);
    }
    async storeSession(sessionId, data) {
        this.sessions.set(sessionId, data);
    }
    async getSession(sessionId) {
        const data = this.sessions.get(sessionId);
        if (!data)
            return null;
        // Check if expired
        if (Date.now() - data.lastActivity > this.ttlMs) {
            this.sessions.delete(sessionId);
            return null;
        }
        return data;
    }
    async updateSessionActivity(sessionId) {
        const data = this.sessions.get(sessionId);
        if (data) {
            data.lastActivity = Date.now();
        }
    }
    async deleteSession(sessionId) {
        this.sessions.delete(sessionId);
    }
    async sessionExists(sessionId) {
        const data = await this.getSession(sessionId);
        return data !== null;
    }
    cleanup() {
        const now = Date.now();
        for (const [sessionId, data] of this.sessions) {
            if (now - data.lastActivity > this.ttlMs) {
                this.sessions.delete(sessionId);
            }
        }
    }
}
exports.InMemorySessionStore = InMemorySessionStore;
//# sourceMappingURL=redis.js.map