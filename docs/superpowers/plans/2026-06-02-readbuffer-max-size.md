# ReadBuffer Max Size Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable maximum buffer size to `ReadBuffer` to prevent unbounded memory growth from a misbehaving stdio peer (GHSA-wqgc-pwpr-pq7r).

**Architecture:** `ReadBuffer.append()` gains a size guard that throws on overflow. Both stdio transports wrap their data handlers in try/catch to catch the throw, report via `onerror`, and close the transport. The constant and constructor option are exported as public API.

**Tech Stack:** TypeScript, vitest

---

### Task 1: Add size guard to ReadBuffer

**Files:**
- Modify: `packages/core/src/shared/stdio.ts:1-42`

- [ ] **Step 1: Write failing tests for buffer overflow**

Add a new `describe` block to `packages/core/test/shared/stdio.test.ts`:

```typescript
describe('buffer size limit', () => {
    test('should throw when buffer exceeds default max size', () => {
        const readBuffer = new ReadBuffer();
        const chunk = Buffer.alloc(1024 * 1024); // 1 MB
        // Default is 10 MB, so 11 appends should fail
        for (let i = 0; i < 10; i++) {
            readBuffer.append(chunk);
        }
        expect(() => readBuffer.append(chunk)).toThrow(
            /ReadBuffer exceeded maximum size/
        );
    });

    test('should throw when buffer exceeds custom max size', () => {
        const readBuffer = new ReadBuffer({ maxBufferSize: 100 });
        readBuffer.append(Buffer.alloc(50));
        expect(() => readBuffer.append(Buffer.alloc(51))).toThrow(
            /ReadBuffer exceeded maximum size/
        );
    });

    test('should clear buffer before throwing on overflow', () => {
        const readBuffer = new ReadBuffer({ maxBufferSize: 100 });
        readBuffer.append(Buffer.alloc(50));
        expect(() => readBuffer.append(Buffer.alloc(51))).toThrow();

        // Buffer should be cleared — can append again
        readBuffer.append(Buffer.alloc(50));
        // And read messages normally
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should allow appending up to exactly the max size', () => {
        const readBuffer = new ReadBuffer({ maxBufferSize: 100 });
        // Should not throw — exactly at limit
        expect(() => readBuffer.append(Buffer.alloc(100))).not.toThrow();
    });

    test('should work with no options (backwards compatible)', () => {
        const readBuffer = new ReadBuffer();
        // Small append should always work
        readBuffer.append(Buffer.from('hello\n'));
        expect(readBuffer.readMessage()).not.toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm --filter @modelcontextprotocol/core test -- packages/core/test/shared/stdio.test.ts`
Expected: FAIL — `ReadBuffer` constructor doesn't accept options yet.

- [ ] **Step 3: Implement the size guard in ReadBuffer**

Modify `packages/core/src/shared/stdio.ts`. The full file should become:

```typescript
import type { JSONRPCMessage } from '../types/index.js';
import { JSONRPCMessageSchema } from '../types/index.js';

export const DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;
    private _maxBufferSize: number;

    constructor(options?: { maxBufferSize?: number }) {
        this._maxBufferSize = options?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    }

    append(chunk: Buffer): void {
        const newSize = (this._buffer?.length ?? 0) + chunk.length;
        if (newSize > this._maxBufferSize) {
            this.clear();
            throw new Error(
                `ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`
            );
        }
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }

    readMessage(): JSONRPCMessage | null {
        while (this._buffer) {
            const index = this._buffer.indexOf('\n');
            if (index === -1) {
                return null;
            }

            const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
            this._buffer = this._buffer.subarray(index + 1);

            try {
                return deserializeMessage(line);
            } catch (error) {
                // Skip non-JSON lines (e.g., debug output from hot-reload tools like
                // tsx or nodemon that write to stdout). Schema validation errors still
                // throw so malformed-but-valid-JSON messages surface via onerror.
                if (error instanceof SyntaxError) {
                    continue;
                }
                throw error;
            }
        }
        return null;
    }

    clear(): void {
        this._buffer = undefined;
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `pnpm --filter @modelcontextprotocol/core test -- packages/core/test/shared/stdio.test.ts`
Expected: All tests PASS (including all existing tests — backwards compatible).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/shared/stdio.ts packages/core/test/shared/stdio.test.ts
git commit -m "fix(core): add max buffer size guard to ReadBuffer

Prevents unbounded memory growth when a stdio peer sends data without
newline delimiters. Default limit is 10 MB, configurable via constructor.

Ref: GHSA-wqgc-pwpr-pq7r"
```

---

### Task 2: Add DEFAULT_MAX_BUFFER_SIZE to public exports

**Files:**
- Modify: `packages/core/src/exports/public/index.ts:70`

- [ ] **Step 1: Add the constant to the public export**

Change line 70 in `packages/core/src/exports/public/index.ts` from:

```typescript
export { deserializeMessage, ReadBuffer, serializeMessage } from '../../shared/stdio.js';
```

to:

```typescript
export { DEFAULT_MAX_BUFFER_SIZE, deserializeMessage, ReadBuffer, serializeMessage } from '../../shared/stdio.js';
```

- [ ] **Step 2: Run typecheck to confirm it compiles**

Run: `pnpm --filter @modelcontextprotocol/core typecheck`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/exports/public/index.ts
git commit -m "feat(core): export DEFAULT_MAX_BUFFER_SIZE from public API"
```

---

### Task 3: Add try/catch to StdioClientTransport data handler

**Files:**
- Modify: `packages/client/src/client/stdio.ts:151-154`

- [ ] **Step 1: Wrap the data handler in try/catch**

Change lines 151-154 of `packages/client/src/client/stdio.ts` from:

```typescript
            this._process.stdout?.on('data', chunk => {
                this._readBuffer.append(chunk);
                this.processReadBuffer();
            });
```

to:

```typescript
            this._process.stdout?.on('data', chunk => {
                try {
                    this._readBuffer.append(chunk);
                    this.processReadBuffer();
                } catch (error) {
                    this.onerror?.(error as Error);
                    this.close().catch(() => {});
                }
            });
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @modelcontextprotocol/client typecheck`
Expected: No errors.

- [ ] **Step 3: Run existing stdio client tests to verify no regression**

Run: `pnpm --filter @modelcontextprotocol/client test -- packages/client/test/client/stdio.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/client/stdio.ts
git commit -m "fix(client): catch ReadBuffer overflow in StdioClientTransport data handler

Prevents an uncaught exception when ReadBuffer.append() throws due to
exceeding the max buffer size. Routes the error to onerror and closes
the transport.

Ref: GHSA-wqgc-pwpr-pq7r"
```

---

### Task 4: Add try/catch to StdioServerTransport data handler

**Files:**
- Modify: `packages/server/src/server/stdio.ts:34-37`

- [ ] **Step 1: Wrap the _ondata handler in try/catch**

Change lines 34-37 of `packages/server/src/server/stdio.ts` from:

```typescript
    _ondata = (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this.processReadBuffer();
    };
```

to:

```typescript
    _ondata = (chunk: Buffer) => {
        try {
            this._readBuffer.append(chunk);
            this.processReadBuffer();
        } catch (error) {
            this.onerror?.(error as Error);
            this.close().catch(() => {});
        }
    };
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @modelcontextprotocol/server typecheck`
Expected: No errors.

- [ ] **Step 3: Run existing stdio server tests to verify no regression**

Run: `pnpm --filter @modelcontextprotocol/server test -- packages/server/test/server/stdio.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/server/stdio.ts
git commit -m "fix(server): catch ReadBuffer overflow in StdioServerTransport data handler

Prevents an uncaught exception when ReadBuffer.append() throws due to
exceeding the max buffer size. Routes the error to onerror and closes
the transport.

Ref: GHSA-wqgc-pwpr-pq7r"
```

---

### Task 5: Full test suite verification

- [ ] **Step 1: Run full typecheck across all packages**

Run: `pnpm typecheck:all`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test:all`
Expected: All tests PASS.

- [ ] **Step 3: Run lint**

Run: `pnpm lint:all`
Expected: No errors (or fix any formatting issues with `pnpm lint:fix:all`).
