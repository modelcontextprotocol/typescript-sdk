---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Forward `cause` from an `SdkError`'s `data` slot to `Error.cause`. Call sites such as `classifyNetworkError` pass the underlying error as `{ cause }` in the `data` parameter, but the constructor called `super(message)` without options, so `Error.cause` stayed `undefined` and cause-chain walkers (pino's default serializer, Sentry) stopped at the `SdkError` — losing the root network error (`ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` all rendered as "fetch failed"). The full `data` object is still retained on `this.data`, and `SdkHttpError`'s status payload is unaffected. Fixes #2657.
