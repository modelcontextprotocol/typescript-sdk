---
'@modelcontextprotocol/client': minor
---

SEP-2350 scope step-up: on `403 insufficient_scope`, `StreamableHTTPClientTransport` now re-authorizes with the **union** of the previously-requested and challenged scopes (`computeScopeUnion`), bypassing the refresh-token branch when the union is a strict superset of the current token's granted scope (`isStrictScopeSuperset`, `AuthOptions.forceReauthorization`). New `onInsufficientScope: 'reauthorize' | 'throw'` (default `'reauthorize'`) and `maxStepUpRetries` (default 1) on `StreamableHTTPClientTransportOptions`; `'throw'` raises the new `InsufficientScopeError`. The GET listen-stream open path now applies the same step-up handling. The previous verbatim-header retry guard is replaced by the bounded per-send counter.
