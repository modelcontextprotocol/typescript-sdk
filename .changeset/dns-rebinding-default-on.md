---
'@modelcontextprotocol/server': minor
---

Enable DNS rebinding protection by default on the streamable HTTP server transport, falling back to a localhost allowlist when no `allowedHosts`/`allowedOrigins` are configured. Set `enableDnsRebindingProtection: false` to disable.
