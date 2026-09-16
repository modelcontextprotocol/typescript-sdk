---
'@modelcontextprotocol/client': patch
---

Treat hostnames ending in `.localhost` as loopback for the SEP-2207 token-endpoint https guard (RFC 6761 §6.3), so host-based multi-tenant local OAuth works.
