---
'@modelcontextprotocol/server': minor
---

Revise `createMcpHandler`'s legacy handling (a behavior change to the unreleased entry). The entry now serves 2025-era (non-envelope) traffic **by default** through per-request stateless serving from the same factory — `legacy: 'stateless'` is the default rather than an
opt-in — and the strict, modern-only posture is selected with the new `legacy: 'reject'` value (the earlier alpha's default). The handler-valued `legacy` option (bring-your-own legacy serving) is removed: existing legacy deployments (for example a sessionful streamable
HTTP wiring) keep serving 2025 traffic by routing in user land with the new `isLegacyRequest(request, parsedBody?)` export, which runs the entry's own classification step — it returns `true` only for requests with no per-request `_meta` envelope claim, while malformed or
incomplete modern claims are NOT legacy and must be routed to the modern handler, which answers them with the documented validation errors. The predicate classifies a clone, so the routed request body stays readable. `legacyStatelessFallback` remains exported as a
standalone fetch-shaped handler with the same stateless serving as the default.
