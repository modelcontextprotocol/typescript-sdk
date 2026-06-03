---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add stateless protocol (SEP-2575) and sessionless transport (SEP-2567) support for client→server requests on the draft 2026-07-28 revision: the per-request `_meta` envelope, `server/discover`, stateless dispatch on Streamable HTTP and stdio, discovery-based dual-era client connect, per-request logging, and the sessionless transport invariants. Opt-in by listing a non-stateful protocol version in `supportedProtocolVersions`; configurations that do not are unaffected.
