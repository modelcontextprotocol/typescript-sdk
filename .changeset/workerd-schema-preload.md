---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add `preloadSchemas()`, an explicit opt-in to eager wire-schema construction, and call it automatically in the Cloudflare Workers builds. The wire schemas are built lazily by default, which is the right trade on process-per-invocation runtimes — but on isolate platforms that bill request CPU while module evaluation runs during isolate warm-up, laziness moves construction into the first request each fresh isolate serves. Calling `preloadSchemas()` at module scope (it is synchronous and idempotent) moves that one-time cost back to module evaluation; the packages' workerd export condition now does this automatically, while the Node and browser builds stay lazy. The server package gains a dedicated browser shim for this (its `browser` condition previously reused the workerd shim), so browser bundles keep lazy construction.
