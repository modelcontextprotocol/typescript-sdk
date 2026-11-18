# events

The server serves two event types with the Events extension (SEP-3415):
`counter.changed`, which the SDK reads through `check` from a counter the
`increment` tool bumps, and `timer.tick`, which a timer feeds through
`emit()`. The client subscribes to both in every delivery mode the leg offers
(poll and push over stdio; over HTTP also webhook, with its receiver on
`127.0.0.1:8599`, an origin the server trusts for development), bumps the
counter once and checks what each subscription receives. Events is served on
2026-07-28 only, so the story has no legacy leg.

```bash
pnpm --filter @mcp-examples/events client            # stdio leg
pnpm --filter @mcp-examples/events run server -- --http --port 3000
pnpm --filter @mcp-examples/events client -- --http http://127.0.0.1:3000/mcp
```

The HTTP leg authenticates with the demo bearer token `demo-token`, whose
subject is the webhook principal. Set `EVENTS_RECEIVER_PORT` on both sides to
move the receiver off port 8599.

See [Serve events](../../docs/servers/events.md) and [Subscribe to events](../../docs/clients/events.md).
