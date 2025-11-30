# SessionStore Extension for Multi-Pod Deployments

This fork adds native support for distributed session storage in the MCP SDK, enabling multi-pod/multi-node deployments where session state must be shared across server instances.

## Quick Start

```typescript
import { StreamableHTTPServerTransport, RedisSessionStore } from '@anthropic-advisori/mcp-sdk/server';
import Redis from 'ioredis';

// Single-pod mode (default) - sessions in memory
const singlePodTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    sessionStorageMode: 'memory'  // This is the default
});

// Multi-pod mode - sessions in Redis
const multiPodTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    sessionStorageMode: 'external',  // ← Explicit mode selection
    sessionStore: new RedisSessionStore({
        redis: new Redis(),
        ttlSeconds: 3600
    })
});
```

## The Problem

The official `@modelcontextprotocol/sdk` stores session state **in-memory**:

```typescript
// Original SDK - sessions are local to each process
private _initialized: boolean = false;
sessionId?: string;
```

This means:
- Sessions cannot be shared across multiple pods/containers
- Load balancers routing requests to different instances will fail
- Sessions are lost on server restart

## The Solution: SessionStorageMode + SessionStore Interface

We've added two new options to `StreamableHTTPServerTransport`:

### SessionStorageMode

```typescript
type SessionStorageMode = 'memory' | 'external';
```

| Mode | Description | Use Case |
|------|-------------|----------|
| `memory` | Sessions in process memory (default) | Single-pod deployments, development |
| `external` | Sessions in external store | Multi-pod deployments, production clusters |

### SessionStore Interface

```typescript
export interface SessionStore {
    storeSession(sessionId: string, data: SessionData): Promise<void>;
    getSession(sessionId: string): Promise<SessionData | null>;
    updateSessionActivity(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    sessionExists(sessionId: string): Promise<boolean>;
}

export interface SessionData {
    sessionId: string;
    initialized: boolean;
    createdAt: number;
    lastActivity: number;
    metadata?: Record<string, unknown>;
}
```

## Usage

### Memory Mode (Default - Single Pod)

```typescript
import { StreamableHTTPServerTransport } from '@anthropic-advisori/mcp-sdk/server';
import { randomUUID } from 'crypto';

// Memory mode is the default - no external dependencies needed
const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // sessionStorageMode: 'memory' is implicit
});
```

### External Mode with Redis (Multi-Pod)

```typescript
import Redis from 'ioredis';
import { StreamableHTTPServerTransport, RedisSessionStore } from '@anthropic-advisori/mcp-sdk/server';
import { randomUUID } from 'crypto';

// Create Redis client
const redis = new Redis({
    host: 'redis.example.com',
    port: 6379,
    password: 'your-password'
});

// Create session store with 1-hour TTL
const sessionStore = new RedisSessionStore({
    redis,
    keyPrefix: 'mcp:session:',
    ttlSeconds: 3600
});

// Create transport with external session storage
const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    sessionStorageMode: 'external',  // ← Explicitly enable external storage
    sessionStore                      // ← Required when mode is 'external'
});

// Check mode at runtime
console.log(transport.sessionStorageMode);        // 'external'
console.log(transport.isUsingExternalSessionStore); // true
```

**Important**: When `sessionStorageMode` is `'external'`, you MUST provide a `sessionStore`. Otherwise, an error will be thrown at construction time.

### Custom Session Store Implementation

Implement the `SessionStore` interface for any backend:

```typescript
import { SessionStore, SessionData } from '@anthropic-advisori/mcp-sdk/server';

class PostgresSessionStore implements SessionStore {
    constructor(private pool: Pool) {}

    async storeSession(sessionId: string, data: SessionData): Promise<void> {
        await this.pool.query(
            `INSERT INTO mcp_sessions (id, data, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '1 hour')
             ON CONFLICT (id) DO UPDATE SET data = $2, expires_at = NOW() + INTERVAL '1 hour'`,
            [sessionId, JSON.stringify(data)]
        );
    }

    async getSession(sessionId: string): Promise<SessionData | null> {
        const result = await this.pool.query(
            `SELECT data FROM mcp_sessions WHERE id = $1 AND expires_at > NOW()`,
            [sessionId]
        );
        return result.rows[0]?.data ?? null;
    }

    // ... implement other methods
}
```

## Backward Compatibility

This is a **non-breaking change**. When `sessionStore` is not provided, the transport behaves exactly as before with in-memory sessions.

| Scenario | Behavior |
|----------|----------|
| `sessionStore` not provided | In-memory sessions (original behavior) |
| `sessionStore` provided | External session storage (Redis, DB, etc.) |

## Key Features

### Cross-Pod Session Recovery

When a request arrives at a different pod than where the session was created, the transport automatically recovers the session from the store:

```typescript
// In validateSession():
if (this._sessionStore) {
    const sessionData = await this._sessionStore.getSession(requestSessionId);
    if (sessionData) {
        // Recover session locally
        this.sessionId = requestSessionId;
        this._initialized = true;
    }
}
```

### Automatic TTL Refresh

Session activity updates refresh the TTL in the store:

```typescript
// On every request:
if (this._sessionStore && this.sessionId) {
    await this._sessionStore.updateSessionActivity(this.sessionId);
}
```

## Included Implementations

### RedisSessionStore

Production-ready Redis implementation with:
- Configurable key prefix
- Configurable TTL
- Automatic activity-based TTL refresh
- Logging callback support

### InMemorySessionStore

For development/testing only - NOT suitable for multi-pod production deployments.

## Migration from Custom Workarounds

If you've implemented custom session recovery (like we did in mcp_virtualserver), you can now remove that code and use native SessionStore:

**Before (with workarounds):**
```typescript
// Custom session recovery logic...
const redisSession = await this.sessionStore.getSession(sessionId);
if (redisSession) {
    // Manually reconstruct transport...
    (transport as any)._initialized = true;
    (transport as any).sessionId = sessionId;
}
```

**After (native support):**
```typescript
const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    sessionStore: myRedisSessionStore  // That's it!
});
```

## PR to Upstream

This feature has been submitted as a PR to the official SDK repository. Until it's merged, use this fork:

```bash
npm install @anthropic-advisori/mcp-sdk
```

## License

MIT (same as original SDK)
