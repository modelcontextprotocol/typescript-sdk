# subscriptions

`subscriptions/listen` change-notification streams (protocol revision 2026-07-28). The server publishes `tools/list_changed`; the client receives it both via the auto-opened stream (`ClientOptions.listChanged`, the same option a 2025-era client sets) and a manual
`client.listen()` call.

The publish surface differs by entry: over HTTP (`createMcpHandler`) the example calls `handler.notify.toolsChanged()` on the cross-request `ServerEventBus`; over stdio (`serveStdio`) it toggles a `RegisteredTool` on the pinned instance, whose `tools/list_changed` the entry's
listen router fans onto every open subscription.

```bash
# stdio (the client spawns the server itself):
pnpm tsx examples/subscriptions/client.ts

# Streamable HTTP (two terminals):
pnpm tsx examples/subscriptions/server.ts --http --port 3000
pnpm tsx examples/subscriptions/client.ts --http http://127.0.0.1:3000/
```
