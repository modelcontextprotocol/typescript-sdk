---
'@modelcontextprotocol/server': minor
---

`ServerEvent` takes optional `params`, which the `subscriptions/listen` router delivers with its own subscription ID, so a gateway can forward change notifications with their `_meta` and extension params.
