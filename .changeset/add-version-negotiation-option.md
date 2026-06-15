---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': minor
---

Add opt-in protocol version negotiation on `ClientOptions.versionNegotiation`. The default is unchanged: without the option (or with `mode: 'legacy'`) the client performs today's 2025 connect sequence byte-identically. `mode: 'auto'` probes the server with `server/discover` at
connect time and conservatively falls back to the plain legacy `initialize` handshake on the same connection unless the outcome is definitive modern evidence; a network outage rejects with a typed connect error, and a probe timeout is transport-aware — on stdio it indicates
a legacy server and falls back to `initialize` on the same stream, on HTTP it rejects with a typed timeout error.
`mode: { pin: '<version>' }` negotiates exactly the pinned modern revision with no fallback. Probe policy lives under `probe: { timeoutMs? }` — the probe inherits the standard request timeout. The probe's `MCP-Protocol-Version`/`Mcp-Method` headers derive from the probe
message body; the transport version slot is never touched during negotiation, so legacy-era traffic carries zero 2026 headers by construction. Adds the `SdkErrorCode.EraNegotiationFailed` code for negotiation-phase connect failures.
