---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`SdkError` and `SdkHttpError` accept standard `ErrorOptions` as an optional fourth constructor argument and forward it to `Error`, so a wrapped error is reachable through the standard `Error.cause` chain. Version-negotiation probe failures (`SdkErrorCode.EraNegotiationFailed`) now use it: the underlying `TypeError: fetch failed` and the DNS or socket error beneath it surface via `error.cause`, so pino, Sentry, and `util.inspect` render `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` instead of stopping at the `SdkError` (#2657). The previous `error.data.cause` slot is still populated for compatibility but is deprecated and slated for removal; read `error.cause` instead.
