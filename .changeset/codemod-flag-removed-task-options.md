---
'@modelcontextprotocol/codemod': patch
---

The v1→v2 codemod no longer rewrites `taskStore`/`taskMessageQueue` McpServer constructor options into `capabilities.tasks` — that target does not exist in v2 (the experimental tasks runtime was removed, SEP-2663). The codemod now leaves the code untouched and emits an action-required diagnostic telling migrators to remove the option, matching the removal guidance already given for `experimental/tasks` imports and the migration guide.
