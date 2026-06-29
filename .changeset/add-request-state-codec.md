---
'@modelcontextprotocol/server': minor
---

Add `createRequestStateCodec({ key, ttlSeconds?, bind? })`, an opt-in HMAC-SHA256 sealing helper for the multi-round-trip `requestState`: `mint` seals a JSON-serializable payload (with TTL and optional context binding) and `verify` drops directly into `ServerOptions.requestState.verify`. WebCrypto-based and runtime-neutral; verification is fail-closed and constant-time. The `ServerOptions.requestState.verify` hook's return type is widened to `unknown | Promise<unknown>` (the seam already discarded the return value) so the codec's `verify` is directly assignable.
