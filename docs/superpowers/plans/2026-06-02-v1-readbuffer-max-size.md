# V1 ReadBuffer Max Size Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the ReadBuffer max size guard from the v2 branch (`fix/stdio-buffer-limit`, commit `08780873`) to v1. This prevents unbounded memory growth when a misbehaving stdio peer sends data without newline delimiters (GHSA-wqgc-pwpr-pq7r).

**Architecture:** `ReadBuffer.append()` gains a size guard that throws on overflow. Both stdio transports wrap their data handlers in try/catch to catch the throw, report via `onerror`, and close the transport. The constant `STDIO_DEFAULT_MAX_BUFFER_SIZE` is exported from `src/shared/stdio.ts`.

**Tech Stack:** TypeScript, vitest

**Key difference from v2:** V1 is a flat `src/` layout (not a monorepo under `packages/`). There is no public re-export index file, so the constant is only exported from `src/shared/stdio.ts` directly.

---

### Task 1: Add size guard to ReadBuffer

**Files:**
- Modify: `src/shared/stdio.ts`
- Modify: `test/shared/stdio.test.ts`

- [ ] **Step 1: Add buffer size limit tests**

Append the following to `test/shared/stdio.test.ts`:

```typescript
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '../../src/shared/stdio.js';

describe('buffer size limit', () => {
    test('should throw when buffer exceeds default max size', () => {
        const readBuffer = new ReadBuffer();
        const chunkSize = 1024 * 1024; // 1 MB
        const chunk = Buffer.alloc(chunkSize);
        const chunksToFill = Math.floor(STDIO_DEFAULT_MAX_BUFFER_SIZE / chunkSize);
        for (let i = 0; i < chunksToFill; i++) {
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
        readBuffer.append(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n'));
        expect(readBuffer.readMessage()).not.toBeNull();
    });
});
```

Also update the existing import at the top of the file — change:

```typescript
import { ReadBuffer } from '../../src/shared/stdio.js';
```

to:

```typescript
import { STDIO_DEFAULT_MAX_BUFFER_SIZE, ReadBuffer } from '../../src/shared/stdio.js';
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest test/shared/stdio.test.ts --run`
Expected: FAIL — `ReadBuffer` constructor doesn't accept options yet, `STDIO_DEFAULT_MAX_BUFFER_SIZE` doesn't exist.

- [ ] **Step 3: Implement the size guard in ReadBuffer**

Modify `src/shared/stdio.ts`. Add the constant and constructor, and add the size guard to `append()`. The full file should become:

```typescript
import { JSONRPCMessage, JSONRPCMessageSchema } from '../types.js';

export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;
    private _maxBufferSize: number;

    constructor(options?: { maxBufferSize?: number }) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
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
        if (!this._buffer) {
            return null;
        }

        const index = this._buffer.indexOf('\n');
        if (index === -1) {
            return null;
        }

        const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
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

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest test/shared/stdio.test.ts --run`
Expected: All tests PASS.

- [ ] **Step 5: Suggest commit**

```bash
git add src/shared/stdio.ts test/shared/stdio.test.ts
git commit -m "fix: add max buffer size guard to ReadBuffer

Prevents unbounded memory growth when a stdio peer sends data without
newline delimiters. Default limit is 10 MB, configurable via constructor.

Ref: GHSA-wqgc-pwpr-pq7r"
```

---

### Task 2: Add try/catch to StdioServerTransport data handler

**Files:**
- Modify: `src/server/stdio.ts:26-29`
- Modify: `test/server/stdio.test.ts`

- [ ] **Step 1: Add overflow test for StdioServerTransport**

Append the following test to `test/server/stdio.test.ts`:

```typescript
test('should fire onerror and close when ReadBuffer overflows', async () => {
    const server = new StdioServerTransport(input, output);

    let receivedError: Error | undefined;
    server.onerror = err => {
        receivedError = err;
    };
    let closeCount = 0;
    server.onclose = () => {
        closeCount++;
    };

    await server.start();

    // Push data exceeding the default 10 MB limit without a newline
    const chunk = Buffer.alloc(11 * 1024 * 1024, 0x41);
    input.push(chunk);

    // Allow the close() promise to settle
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(receivedError?.message).toMatch(/ReadBuffer exceeded maximum size/);
    expect(closeCount).toBe(1);
});
```

- [ ] **Step 2: Run to confirm the test fails**

Run: `npx vitest test/server/stdio.test.ts --run`
Expected: FAIL — the uncaught throw from `append()` crashes instead of being caught.

- [ ] **Step 3: Wrap the _ondata handler in try/catch**

Change lines 26-29 of `src/server/stdio.ts` from:

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

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest test/server/stdio.test.ts --run`
Expected: All tests PASS.

- [ ] **Step 5: Suggest commit**

```bash
git add src/server/stdio.ts test/server/stdio.test.ts
git commit -m "fix(server): catch ReadBuffer overflow in StdioServerTransport

Prevents an uncaught exception when ReadBuffer.append() throws due to
exceeding the max buffer size. Routes the error to onerror and closes
the transport.

Ref: GHSA-wqgc-pwpr-pq7r"
```

---

### Task 3: Add try/catch to StdioClientTransport data handler

**Files:**
- Modify: `src/client/stdio.ts:150-153`
- Modify: `test/client/stdio.test.ts`

- [ ] **Step 1: Add overflow test for StdioClientTransport**

Append the following test to `test/client/stdio.test.ts`:

```typescript
test('should fire onerror and close when ReadBuffer overflows', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 0x41))']
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});
```

- [ ] **Step 2: Run to confirm the test fails**

Run: `npx vitest test/client/stdio.test.ts --run`
Expected: FAIL — the uncaught throw from `append()` crashes.

- [ ] **Step 3: Wrap the stdout data handler in try/catch**

Change lines 150-153 of `src/client/stdio.ts` from:

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

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest test/client/stdio.test.ts --run`
Expected: All tests PASS.

- [ ] **Step 5: Suggest commit**

```bash
git add src/client/stdio.ts test/client/stdio.test.ts
git commit -m "fix(client): catch ReadBuffer overflow in StdioClientTransport

Prevents an uncaught exception when ReadBuffer.append() throws due to
exceeding the max buffer size. Routes the error to onerror and closes
the transport.

Ref: GHSA-wqgc-pwpr-pq7r"
```

---

### Task 4: Full verification

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors (or fix with `npm run lint:fix`).
