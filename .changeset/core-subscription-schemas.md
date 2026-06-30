---
'@modelcontextprotocol/core': major
---

Align the published schema set with the 2026-07-28 surface: removes the
`RequestMetaEnvelopeSchema` export; adds `SubscriptionFilterSchema`, the
`SubscriptionsListen*` request/result schemas, and the
`SubscriptionsAcknowledged*` notification schemas. The bundled schemas now
match `@modelcontextprotocol/client` and `@modelcontextprotocol/server` of
the same release.
