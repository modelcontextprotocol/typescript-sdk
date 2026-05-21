---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Drop `zod` from `peerDependencies` (kept as direct dependency)

Since Standard Schema support landed, `zod` is purely an internal runtime dependency used for protocol message parsing. User-facing schemas (`registerTool`, `registerPrompt`) accept any Standard Schema library. `zod` remains in `dependencies` and auto-installs; users no longer
need to install it alongside the SDK.
