# caching

`CacheableResult` freshness hints (protocol revision 2026-07-28). The server declares hints at two layers — a per-registration `cacheHint` on the resource and server-level `ServerOptions.cacheHints` — and the SDK resolves most-specific-author-first (handler-return fields would
take precedence over both) and stamps `ttlMs`/`cacheScope` on the wire toward modern clients only. The client reads the stamped values back.

> Full client-side cache **honouring** (re-using a still-fresh result instead of re-requesting) is a follow-up; this example reads what the server emits today.

```bash
pnpm tsx examples/caching/client.ts
```
