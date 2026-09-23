---
'@modelcontextprotocol/client': patch
---

Treat hostnames ending in `.localhost` as loopback for the SEP-2207 token-endpoint https guard (RFC 6761 §6.3), so host-based multi-tenant local OAuth works. The SDK does not resolve the name itself: `*.localhost` reaches the local machine only if the system resolver follows RFC 6761.
