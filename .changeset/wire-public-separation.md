---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Freeze the per-era wire schemas as self-contained copies decoupled from the public types layer, and convert `WireCodec` to a function-only interface. Two small spec-conformance fixes ride along with the otherwise-pure refactor:

- Receiver-side defaults for `resultType` (`'complete'`), `ttlMs` (`0`) and `cacheScope` (`'private'`) on inbound 2026-era results, per the spec's receiver leniency (caching.mdx §receiver). Absent or malformed cache hints now fall back to the spec defaults instead of failing validation.
- The sampling `hasTools` discriminant now keys on `tools || toolChoice` (previously `tools` only), aligning the client and server selection of the with-tools result variant with `clientCapabilityRequirements`.
