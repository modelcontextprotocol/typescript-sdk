# streaming

The three in-flight channels: progress (via `_meta.progressToken` → `notifications/progress` → the client's `onprogress` callback), logging (`ctx.mcpReq.log(level, data)` → `notifications/message`), and cancellation (the client's `AbortSignal` → `ctx.mcpReq.signal.aborted`
server-side).

```bash
pnpm tsx examples/streaming/client.ts
```
