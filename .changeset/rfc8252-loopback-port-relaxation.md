---
'@modelcontextprotocol/sdk': patch
---

The authorization handler now applies RFC 8252 §7.3 loopback port relaxation when validating `redirect_uri` against a client's registered URIs. For `localhost`, `127.0.0.1`, and `[::1]` hosts, any port is accepted as long as scheme, host, path, and query match. This fixes native
clients that obtain an ephemeral port from the OS but register a portless loopback URI (e.g., via CIMD / SEP-991).
