import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisSessionStore, InMemorySessionStore, RedisClient } from './redis.js';
import { SessionData } from '../streamableHttp.js';

/**
 * Mock Redis Client for testing
 */
function createMockRedisClient(): RedisClient & {
    _store: Map<string, { value: string; expiry: number }>;
    _getKey: (key: string) => { value: string; expiry: number } | undefined;
} {
    const store = new Map<string, { value: string; expiry: number }>();

    return {
        _store: store,
        _getKey: (key: string) => store.get(key),

        async get(key: string): Promise<string | null> {
            const entry = store.get(key);
            if (!entry) return null;
            // Check expiry
            if (entry.expiry > 0 && Date.now() > entry.expiry) {
                store.delete(key);
                return null;
            }
            return entry.value;
        },

        async setex(key: string, seconds: number, value: string): Promise<'OK'> {
            store.set(key, {
                value,
                expiry: Date.now() + seconds * 1000
            });
            return 'OK';
        },

        async del(key: string | string[]): Promise<number> {
            const keys = Array.isArray(key) ? key : [key];
            let deleted = 0;
            for (const k of keys) {
                if (store.delete(k)) deleted++;
            }
            return deleted;
        },

        async exists(key: string | string[]): Promise<number> {
            const keys = Array.isArray(key) ? key : [key];
            let count = 0;
            for (const k of keys) {
                const entry = store.get(k);
                if (entry && (entry.expiry === 0 || Date.now() <= entry.expiry)) {
                    count++;
                }
            }
            return count;
        },

        async expire(key: string, seconds: number): Promise<number> {
            const entry = store.get(key);
            if (!entry) return 0;
            entry.expiry = Date.now() + seconds * 1000;
            return 1;
        }
    };
}

describe('RedisSessionStore', () => {
    let mockRedis: ReturnType<typeof createMockRedisClient>;
    let sessionStore: RedisSessionStore;
    const testSessionId = 'test-session-123';

    beforeEach(() => {
        mockRedis = createMockRedisClient();
        sessionStore = new RedisSessionStore({
            redis: mockRedis,
            keyPrefix: 'mcp:test:session:',
            ttlSeconds: 3600
        });
    });

    describe('storeSession', () => {
        it('should store session data in Redis', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);

            const stored = mockRedis._getKey(`mcp:test:session:${testSessionId}`);
            expect(stored).toBeDefined();
            expect(JSON.parse(stored!.value)).toEqual(sessionData);
        });

        it('should set TTL when storing session', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);

            const stored = mockRedis._getKey(`mcp:test:session:${testSessionId}`);
            expect(stored).toBeDefined();
            // TTL should be approximately 3600 seconds from now
            const expectedExpiry = Date.now() + 3600 * 1000;
            expect(stored!.expiry).toBeGreaterThan(expectedExpiry - 1000);
            expect(stored!.expiry).toBeLessThan(expectedExpiry + 1000);
        });

        it('should store session with metadata', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now(),
                metadata: { serverId: 'server-1', userId: 'user-123' }
            };

            await sessionStore.storeSession(testSessionId, sessionData);

            const retrieved = await sessionStore.getSession(testSessionId);
            expect(retrieved?.metadata).toEqual({ serverId: 'server-1', userId: 'user-123' });
        });
    });

    describe('getSession', () => {
        it('should retrieve stored session', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: 1000,
                lastActivity: 2000
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            const retrieved = await sessionStore.getSession(testSessionId);

            expect(retrieved).toEqual(sessionData);
        });

        it('should return null for non-existent session', async () => {
            const retrieved = await sessionStore.getSession('non-existent');
            expect(retrieved).toBeNull();
        });

        it('should return null for expired session', async () => {
            // Create a store with 1 second TTL
            const shortTtlStore = new RedisSessionStore({
                redis: mockRedis,
                ttlSeconds: 0 // Immediate expiry for test
            });

            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            // Manually set expired data
            mockRedis._store.set(`mcp:session:${testSessionId}`, {
                value: JSON.stringify(sessionData),
                expiry: Date.now() - 1000 // Already expired
            });

            const retrieved = await shortTtlStore.getSession(testSessionId);
            expect(retrieved).toBeNull();
        });
    });

    describe('updateSessionActivity', () => {
        it('should update lastActivity timestamp', async () => {
            const originalTime = Date.now() - 10000;
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: originalTime,
                lastActivity: originalTime
            };

            await sessionStore.storeSession(testSessionId, sessionData);

            // Wait a bit to ensure time difference
            await new Promise(resolve => setTimeout(resolve, 10));

            await sessionStore.updateSessionActivity(testSessionId);

            const retrieved = await sessionStore.getSession(testSessionId);
            expect(retrieved?.lastActivity).toBeGreaterThan(originalTime);
            expect(retrieved?.createdAt).toBe(originalTime); // Should not change
        });

        it('should not throw for non-existent session', async () => {
            // Should not throw
            await expect(sessionStore.updateSessionActivity('non-existent')).resolves.not.toThrow();
        });
    });

    describe('deleteSession', () => {
        it('should delete session from Redis', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            expect(await sessionStore.sessionExists(testSessionId)).toBe(true);

            await sessionStore.deleteSession(testSessionId);

            expect(await sessionStore.sessionExists(testSessionId)).toBe(false);
            expect(await sessionStore.getSession(testSessionId)).toBeNull();
        });

        it('should not throw when deleting non-existent session', async () => {
            await expect(sessionStore.deleteSession('non-existent')).resolves.not.toThrow();
        });
    });

    describe('sessionExists', () => {
        it('should return true for existing session', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            expect(await sessionStore.sessionExists(testSessionId)).toBe(true);
        });

        it('should return false for non-existent session', async () => {
            expect(await sessionStore.sessionExists('non-existent')).toBe(false);
        });
    });

    describe('custom key prefix', () => {
        it('should use custom key prefix', async () => {
            const customStore = new RedisSessionStore({
                redis: mockRedis,
                keyPrefix: 'custom:prefix:',
                ttlSeconds: 3600
            });

            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await customStore.storeSession(testSessionId, sessionData);

            expect(mockRedis._getKey(`custom:prefix:${testSessionId}`)).toBeDefined();
            expect(mockRedis._getKey(`mcp:session:${testSessionId}`)).toBeUndefined();
        });
    });

    describe('logging callback', () => {
        it('should call onLog callback', async () => {
            const logSpy = vi.fn();
            const loggingStore = new RedisSessionStore({
                redis: mockRedis,
                onLog: logSpy
            });

            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await loggingStore.storeSession(testSessionId, sessionData);

            expect(logSpy).toHaveBeenCalledWith('debug', expect.stringContaining('Session stored'));
        });
    });
});

describe('InMemorySessionStore', () => {
    let sessionStore: InMemorySessionStore;
    const testSessionId = 'test-session-456';

    beforeEach(() => {
        sessionStore = new InMemorySessionStore(3600);
    });

    describe('basic operations', () => {
        it('should store and retrieve session', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            const retrieved = await sessionStore.getSession(testSessionId);

            expect(retrieved).toEqual(sessionData);
        });

        it('should delete session', async () => {
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            await sessionStore.deleteSession(testSessionId);

            expect(await sessionStore.getSession(testSessionId)).toBeNull();
        });

        it('should check session existence', async () => {
            expect(await sessionStore.sessionExists(testSessionId)).toBe(false);

            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now()
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            expect(await sessionStore.sessionExists(testSessionId)).toBe(true);
        });

        it('should update session activity', async () => {
            const originalTime = Date.now() - 10000;
            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: originalTime,
                lastActivity: originalTime
            };

            await sessionStore.storeSession(testSessionId, sessionData);
            await sessionStore.updateSessionActivity(testSessionId);

            const retrieved = await sessionStore.getSession(testSessionId);
            expect(retrieved?.lastActivity).toBeGreaterThan(originalTime);
        });
    });

    describe('TTL behavior', () => {
        it('should expire sessions after TTL', async () => {
            // Create store with very short TTL (100ms)
            const shortTtlStore = new InMemorySessionStore(0.1); // 0.1 seconds = 100ms

            const sessionData: SessionData = {
                sessionId: testSessionId,
                initialized: true,
                createdAt: Date.now(),
                lastActivity: Date.now() - 200 // Already past TTL
            };

            await shortTtlStore.storeSession(testSessionId, sessionData);

            // Session should be considered expired
            const retrieved = await shortTtlStore.getSession(testSessionId);
            expect(retrieved).toBeNull();
        });
    });
});
