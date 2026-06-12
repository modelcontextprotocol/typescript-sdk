---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': minor
---

Add opt-in protocol version negotiation on `ClientOptions.versionNegotiation`. The default is unchanged: without the option (or with `mode: 'legacy'`) the client performs today's 2025 connect sequence byte-identically. `mode: 'auto'` probes the server with `server/discover` at
connect time and conservatively falls back to the plain legacy `initialize` handshake on the same connection unless the outcome is definitive modern evidence; network outage and probe timeout reject with typed connect errors and are never converted to an era verdict.
`mode: { pin: '<version>' }` negotiates exactly the pinned modern revision with no fallback. Probe policy lives under `probe: { timeoutMs?, maxRetries? }` — the probe inherits the standard request timeout, and `maxRetries` governs timeout re-sends only (the spec-mandated
`-32004` corrective continuation is not counted against it). The probe's `MCP-Protocol-Version`/`Mcp-Method` headers derive from the probe message body; the transport version slot is never touched during negotiation, so legacy-era traffic carries zero 2026 headers by
construction. Adds `Client.getProtocolEra()` and the `SdkErrorCode.EraNegotiationFailed` code for negotiation-phase connect failures.
