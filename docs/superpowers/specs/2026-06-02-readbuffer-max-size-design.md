# ReadBuffer Maximum Size Guard

**Date:** 2026-06-02
**Advisory:** GHSA-wqgc-pwpr-pq7r
**Severity:** Low (DoS via stdio transport, local attack surface)

## Problem

`ReadBuffer.append()` in `packages/core/src/shared/stdio.ts` concatenates incoming data with no size limit. A malicious MCP server subprocess can write continuous data to stdout without newline delimiters, causing the host process (Claude Desktop, Cursor, VS Code, etc.) to grow memory without bound until OOM-killed.

The `data` event handlers in both `StdioClientTransport` and `StdioServerTransport` call `append()` outside any try/catch, so a thrown error from `append()` would become an uncaught exception — this must also be addressed.

## Design

### 1. ReadBuffer (`packages/core/src/shared/stdio.ts`)

- Add exported constant `DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024` (10 MB).
- Constructor accepts optional `{ maxBufferSize?: number }` options object.
- `append()` checks `(currentSize + chunk.length) > maxBufferSize` before concatenating.
- On overflow: call `this.clear()` first (leave object in clean state), then throw `Error`.
- Fully backwards compatible — `new ReadBuffer()` with no args uses the default.

### 2. StdioClientTransport (`packages/client/src/client/stdio.ts`)

- Wrap the `stdout.on('data')` handler body in try/catch.
- On catch: route error to `this.onerror?.(error)`, then call `this.close()`.

### 3. StdioServerTransport (`packages/server/src/server/stdio.ts`)

- Wrap the `_ondata` handler body in try/catch.
- On catch: route error to `this.onerror?.(error)`, then call `this.close()`.

### 4. Tests (`packages/core/test/shared/stdio.test.ts`)

- `append()` throws when buffer exceeds default limit.
- `append()` throws with custom `maxBufferSize`.
- Buffer is cleared after overflow (object reusable).
- Default limit can be overridden via constructor.

### 5. No changes to

- Public API exports (`ReadBuffer` is already exported; constructor change is additive).
- `processReadBuffer()` in either transport (existing try/catch handles `readMessage()` errors; new try/catch handles `append()` errors at a higher level).

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/shared/stdio.ts` | Add `DEFAULT_MAX_BUFFER_SIZE`, constructor options, size guard in `append()` |
| `packages/client/src/client/stdio.ts` | try/catch in `data` handler, close on overflow |
| `packages/server/src/server/stdio.ts` | try/catch in `_ondata` handler, close on overflow |
| `packages/core/test/shared/stdio.test.ts` | New tests for buffer overflow behavior |

## Decision Log

- **10 MB default** chosen because a single JSON-RPC message shouldn't realistically exceed a few MB (even a 7 MB binary base64-encoded is ~9.3 MB). Users with legitimate large messages can raise the cap explicitly.
- **Throw from append()** rather than silent truncation or callback — uses existing error propagation paths and makes the failure visible.
- **Clear before throw** so the ReadBuffer isn't left in a corrupt state.
- **Close transport on overflow** because a buffer overflow means the peer is misbehaving and any partial data is unrecoverable.
- **No chunk-list optimization** — the 10 MB cap bounds the `Buffer.concat()` amplification to ~50 MB worst case, which is acceptable. Chunk-list can be a separate follow-up.
- **Options object** (not bare number) for the constructor parameter, for future extensibility.
