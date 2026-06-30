---
status: scaffold
shape: explanation
---
# Protocol versions

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Eras — THE single quarantine page; the behavior matrix MOVES here from the support guide.
teaches: ClientOptions.versionNegotiation, Client.getProtocolEra, ProtocolOptions.supportedProtocolVersions, createMcpHandler legacy option, serveStdio legacy option, SdkError(EraNegotiationFailed)
source: mined from docs/migration/support-2026-07-28.md "Serving the 2026-07-28 revision", "Client side: versionNegotiation", "Probe policy", "Appendix: 2025-era vs 2026-era behavior matrix"
NOTE: this is the ONE era page. Every other page's era caveat is a single line linking here
(CONVENTIONS R8 / proposal principle 3). The behavior matrix is MOVED here, not copied —
the support guide links to this page and stops owning it (one maintained copy, ever).
-->

## Name the two eras
<!-- teaches: ProtocolEra ('legacy' | 'modern') | salvage: docs/migration/support-2026-07-28.md intro + agent-report 89 §1.2 -->
<!-- code: none — two short paragraphs: an "era" is a behavior family, not a version string; 2025-era = 2024-10-07 … 2025-11-25, 2026-era = 2026-07-28; why the SDK serves both -->

## Negotiate the era from the client
<!-- teaches: ClientOptions.versionNegotiation, Client.getProtocolEra | salvage: docs/migration/support-2026-07-28.md "Client side: versionNegotiation" -->
`versionNegotiation` decides which handshake `connect()` performs; the default is the 2025 `initialize` handshake, byte for byte.

```ts
// draft - API verified against packages/client/src/client/client.ts (ClientOptions.versionNegotiation L206, getProtocolEra L1272) and packages/client/src/client/versionNegotiation.ts (VersionNegotiationOptions.mode)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp')));

client.getProtocolEra(); // 'modern' or 'legacy' once connected; undefined before
```
<!-- result: against a 2026-07-28 server getProtocolEra() returns 'modern'; against a 2025-only server the same connect() falls back and returns 'legacy' -->

## Pin an era
<!-- teaches: mode: 'legacy', mode: { pin: '2026-07-28' }, SdkError(EraNegotiationFailed) -->
<!-- code: the three mode values as a placeholder block: absent/'legacy' (no probe), 'auto' (probe + fallback), { pin } (modern only, connect() rejects with SdkError(EraNegotiationFailed) against a 2025-only server) -->

## Understand the probe
<!-- teaches: versionNegotiation.probe (timeoutMs, maxRetries), supportedProtocolVersions | salvage: docs/migration/support-2026-07-28.md "Probe policy" -->
<!-- code: probe: { timeoutMs, maxRetries } placeholder; prose covers transport-aware timeouts (stdio falls back, HTTP rejects), the browser CORS exception, and who should NOT default to 'auto' (spawn-per-invocation CLI tools) -->

## Serve both eras from one entry point
<!-- teaches: createMcpHandler legacy: 'stateless' | 'reject', serveStdio legacy option | salvage: docs/migration/support-2026-07-28.md "Server over HTTP: createMcpHandler", "Server over stdio / long-lived connections: serveStdio" -->
<!-- code: createMcpHandler(factory, { legacy: 'stateless' }) placeholder; one line linking /serving/legacy-clients, which owns the legacy: option and the full recipe -->

## Compare the eras
<!-- teaches: the behavior matrix | salvage: docs/migration/support-2026-07-28.md "Appendix: 2025-era vs 2026-era behavior matrix" — MOVED here verbatim (the table carve-out is allowed on this reference-flavored page) -->
<!-- code: none — the nine-axis 2025-era vs 2026-07-28 table lands here as the page's centerpiece -->

## Separate deprecation from era
<!-- teaches: SEP-2577 (sampling, roots, ctx.mcpReq.log) is deprecation, not an era caveat | salvage: agent-report 89 §1.2 + proposal principle 4 -->
<!-- code: none — one short paragraph: deprecated surfaces carry their own on-page sunset banner; this page is not where deprecation lives -->

## Link here instead of explaining inline
<!-- teaches: the quarantine rule for every other page | salvage: proposal principle 3 ("Tell the era story exactly once") -->
<!-- code: none — the one-line cross-link form other pages use, shown as the example sentence authors copy -->

## Recap
<!-- the claims this page will prove:
- An era is a behavior family; the SDK serves 2025-era and 2026-07-28 from the same entry points.
- versionNegotiation picks the client handshake; the default is the unchanged 2025 initialize.
- 'auto' probes with server/discover and falls back; a pin never falls back.
- getProtocolEra() tells you what was negotiated.
- The behavior matrix on this page is the only copy; every other page links here in one line.
- Deprecation (SEP-2577) is not an era difference.
-->
