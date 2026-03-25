---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/client": minor
"@modelcontextprotocol/server": minor
---

refactor: extract task orchestration from Protocol into TaskManager

**Breaking changes:**
- `taskStore`, `taskMessageQueue`, `defaultTaskPollInterval`, and `maxTaskQueueSize` moved from `ProtocolOptions` to `capabilities.tasks` on `ClientOptions`/`ServerOptions`
