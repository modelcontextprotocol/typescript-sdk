# caching

`CacheableResult` freshness hints (protocol revision 2026-07-28). The server declares hints at three layers (handler return → per-registration `cacheHint` → server-level `ServerOptions.cacheHints`); the SDK resolves most-specific-author-first and stamps `ttlMs`/`cacheScope` on
the wire toward modern clients only. The client reads the stamped values back.

> Full client-side cache **honouring** (re-using a still-fresh result instead of re-requesting) is a follow-up; this example reads what the server emits today.

```bash
pnpm tsx examples/caching/client.ts
```
