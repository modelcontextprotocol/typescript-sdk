# streaming

The three in-flight channels: progress (via `_meta.progressToken` → `notifications/progress` → the client's `onprogress` callback), logging (`ctx.mcpReq.notify({ method: 'notifications/message', … })` — request-tied so it rides the same response stream as progress; the
connection-level `ctx.mcpReq.log` shorthand sends an unrelated notification a per-request HTTP entry cannot deliver mid-call), and cancellation (the client's `AbortSignal` → `ctx.mcpReq.signal.aborted` server-side).

```bash
pnpm tsx examples/streaming/client.ts
```
