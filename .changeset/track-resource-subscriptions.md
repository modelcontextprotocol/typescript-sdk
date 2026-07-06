---
'@modelcontextprotocol/server': minor
---

Add SDK-owned bookkeeping for 2025-era per-resource subscriptions to `McpServer`.
Declaring the `resources.subscribe` capability now activates it automatically at
`connect()`: the SDK installs the `resources/subscribe` and `resources/unsubscribe`
handlers (unless either verb already has a hand-registered handler, which wins) and
records subscribed URIs in the new per-connection `resourceSubscriptions` read-only
set. `trackResourceSubscriptions({ onSubscribe?, onUnsubscribe? })` is the explicit
configuration path — it declares the capability, installs the handlers, and attaches
veto hooks that run before the set changes and can refuse a request by throwing. A
`sendResourceUpdated` facade joins `sendResourceListChanged` so apps no longer reach
through `.server` to deliver `notifications/resources/updated`.

Behavior change: apps that declared `resources: { subscribe: true }` but never
registered subscribe handlers previously advertised the capability while answering
`-32601 Method not found`; they now get working SDK-owned subscribe/unsubscribe.
See the migration guide's "Server (McpServer / Streamable HTTP behavior)" section.
