---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Add `STATEFUL_PROTOCOL_VERSIONS` (the closed list of protocol versions negotiated via the `initialize` handshake) and `DRAFT_PROTOCOL_VERSION_2026` / `DRAFT_PROTOCOL_VERSIONS` constants. Protocol revisions after 2025-11-25 are never negotiated via `initialize`: clients request
and servers accept/fall back to stateful versions only. Behavior change: `supportedProtocolVersions` entries outside the stateful list (custom or future strings) no longer participate in the handshake — see migration.md.
