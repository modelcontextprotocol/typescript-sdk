---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': minor
---

Per-request `_meta` envelope auto-emission on modern-era connections: once a client negotiates a 2026-07-28+ protocol revision (via `versionNegotiation: { mode: 'auto' }` or `{ pin }`), it automatically attaches the reserved protocol-version / client-info / client-capabilities
`_meta` keys to every outgoing request and notification — you no longer set the envelope by hand. User-supplied `_meta` keys take precedence over the auto-attached ones; the auto-attached client-capabilities reflect what the client actually registered. Legacy-era connections
(the default, and the `'auto'`-mode fallback) never gain these keys, so 2025-era outbound traffic is byte-identical to before.

Adds `Client.getProtocolEra()` (`'legacy' | 'modern' | undefined`), the `ProtocolEra` type, `Client.setVersionNegotiation()` for configuring negotiation pre-connect on an already-constructed instance, and the `probe.maxRetries` knob (default `0`) which governs probe-timeout
re-sends only — the spec-mandated `-32004` corrective continuation is never counted against it. The `versionNegotiation` default remains `'legacy'`: absent (or `mode: 'legacy'`), `connect()` runs the plain 2025 sequence, byte-identical to a v1.x client.
