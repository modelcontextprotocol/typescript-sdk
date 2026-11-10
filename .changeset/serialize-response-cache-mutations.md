---
'@modelcontextprotocol/client': patch
---

Serialize response-cache mutations for each logical key. A custom
`ResponseCacheStore` may apply `set()` asynchronously; previously, a
`list_changed` or `resources/updated` invalidation could finish its delete
while an earlier write was still pending, allowing that stale write to restore
the entry afterward.

Writes and invalidations now retain their invocation order per key. An
invalidation removes any earlier delayed write, while a fresh write started
after the invalidation remains cached.
