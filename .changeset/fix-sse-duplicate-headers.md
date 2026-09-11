---
'@modelcontextprotocol/client': patch
---

fix(sse): avoid passing entire init object to custom fetch to prevent duplicate headers

When `eventSourceInit.fetch` provides a custom fetch implementation, only pass `signal` from `init` rather than spreading the entire `init` object. This prevents duplicate `Authorization` headers caused by the `Headers` instance from `_commonHeaders()` being mixed with user-provided headers through object spread.
