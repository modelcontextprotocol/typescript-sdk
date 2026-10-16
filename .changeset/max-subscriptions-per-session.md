---
'@modelcontextprotocol/server': minor
---

Add `maxSubscriptionsPerSession` and `getSessionId` options to `createMcpHandler` for per-session `subscriptions/listen` fairness. Open listen streams are counted per session key resolved by `getSessionId(options, request)` and compared against the cap before the SSE ack; a refusal returns the same `-32603 "Subscription limit reached"` error as the existing handler-wide `maxSubscriptions` guard. The SDK does not authenticate the resolver's returned value. Deployments must derive the key from a trusted source (for example `authInfo.extra`), not from raw inbound headers.

Fail-closed by construction: setting `maxSubscriptionsPerSession` without `getSessionId` throws `TypeError` at `createMcpHandler` time; a resolver returning `undefined` for a given listen refuses the stream rather than silently falling back to the handler-wide cap. Closes #3036.
