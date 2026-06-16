---
'@modelcontextprotocol/server': minor
---

Add `ServerOptions.eraSupport: 'legacy' | 'dual-era' | 'modern'`, the opt-in for serving the 2026-07-28 draft revision on long-lived connections such as stdio. The default is `'legacy'` and preserves today's behavior exactly: nothing 2026-era is registered or advertised, and 2025
wire behavior is unchanged by the upgrade. `'dual-era'` serves both protocol eras on the same connection, selecting the era per message (`initialize`-negotiated 2025 traffic as before, per-request `_meta` envelope traffic — including `server/discover` — on the modern era), while
methods that exist in only one era stay invisible to the other. `'modern'` is strict 2026-only: requests without the envelope (including `initialize`) are answered with the unsupported-protocol-version error naming the supported revisions. A 2026-era revision in
`supportedProtocolVersions` now requires declaring `eraSupport` (`'dual-era'` or `'modern'`); on a default `'legacy'` instance it throws a `TypeError` at construction instead of silently installing the `server/discover` handler. On dual-era instances the deprecated
client-identity accessors keep their `initialize`-scoped semantics and are never backfilled from 2026-era requests; handlers read per-request identity from `ctx.mcpReq.envelope`.
