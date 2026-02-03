---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/client": minor
"@modelcontextprotocol/server": minor
---

refactor: extract task orchestration from Protocol into TaskManager

**Breaking changes:**
- `extra.taskId` → `extra.task?.taskId`
- `extra.taskStore` → `extra.task?.taskStore`
- `extra.taskRequestedTtl` → `extra.task?.requestedTtl`
- `ProtocolOptions` no longer accepts `taskStore`/`taskMessageQueue` — pass via `TaskManagerOptions` in `ClientOptions`/`ServerOptions`
- Abstract methods `assertTaskCapability`/`assertTaskHandlerCapability` removed from Protocol
