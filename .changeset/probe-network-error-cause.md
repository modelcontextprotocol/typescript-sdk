---
'@modelcontextprotocol/client': patch
---

Put the version-negotiation probe's underlying network failure on `Error.cause`. `SdkError`'s third constructor parameter is `data`, not `ErrorOptions`, so `classifyNetworkError` passing `{ cause: error }` left `Error.cause` undefined and stranded the failure at `error.data.cause`. Anything walking the standard `.cause` chain — loggers, error reporters, `util.inspect` — stopped at the `SdkError` and never reached the `TypeError: fetch failed`, nor the DNS or socket error beneath it that names the actual problem.
