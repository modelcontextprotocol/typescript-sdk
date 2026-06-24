---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Freeze the per-era wire schemas as self-contained copies decoupled from the public types layer, and convert `WireCodec` to a function-only interface. Two small spec-conformance fixes ride along with the otherwise-pure refactor:

- The 2026 wire-true `resultType` member now defaults to `'complete'` when absent (the spec's receiver-side back-compat rule); the inbound `decodeResult` step continues to require it. The `server/discover` result accepts absent or malformed `ttlMs`/`cacheScope` (falling back to `0`/`'private'` per the spec's receiver leniency in caching.mdx) so the version-negotiation probe classifier stays behavior-neutral. Other cacheable result schemas are unchanged here; general receiver leniency for those belongs to the response-cache surface.
- The sampling `hasTools` discriminant now keys on `tools || toolChoice` (previously `tools` only), aligning the client and server selection of the with-tools result variant with `clientCapabilityRequirements`.
