---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Restore the 2025-11-25 task wire types that were removed together with the task feature: the task schemas and inferred types, task members of the request/result/notification unions, the `task` request-params augmentation, the `tasks` capability key, the `isTaskAugmentedRequestParams` guard, and `RELATED_TASK_META_KEY`. The task feature itself remains removed — servers do not advertise the `tasks` capability and inbound `tasks/*` requests receive `-32601` — but the wire surface stays so SDKs interoperate cleanly with peers on the 2025-11-25 revision.
