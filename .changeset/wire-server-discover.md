---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Wire `server/discover` (protocol revision 2026-07-28) into the typed request funnel and serve it era-aware. The request joins `ClientRequestSchema`/`ServerResultSchema`/`ResultTypeMap` (per-era availability stays with the wire registries: only the 2026-era registry serves
it), and `Client.discover()` issues it as a typed request on 2026-era connections. A `Server` whose `supportedProtocolVersions` list carries a modern (2026-07-28+) revision installs the `server/discover` handler, advertising ONLY its modern revisions and excluding the
listChanged/subscribe-class capabilities until the `subscriptions/listen` flow ships; servers with today's default list are unchanged and keep answering `-32601`. The `initialize` handshake is now era-aware in the other direction: its accept check and counter-offer consult
only the legacy subset of the supported versions — a 2026-era revision is never negotiated via `initialize` — so a 2025-era client can never be offered a 2026 version string; with the default list this is byte-identical to previous behavior. Serving the 2026 revision to
ordinary HTTP/stdio traffic arrives with an upcoming server-side entry point: today the negotiation surface is client-side, and `mode: 'auto'` falls back cleanly against current SDK servers.
