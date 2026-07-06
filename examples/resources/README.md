# resources

Direct resources (a fixed URI string), templated resources (`ResourceTemplate('greeting://{name}')`), and per-resource subscriptions. The client lists both kinds, reads the direct config and a templated greeting, then subscribes to `counter://value` — `subscriptions/listen` on 2026-07-28, `resources/subscribe` on 2025 — calls the `increment` tool, and asserts the `notifications/resources/updated` it produces. Per-request legacy HTTP has no delivery channel, so that leg skips the delivery assertion.

```bash
pnpm tsx examples/resources/client.ts
```
