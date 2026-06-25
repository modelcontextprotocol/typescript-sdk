---
'@modelcontextprotocol/core': minor
---

The public Zod-schema package previously published (in alpha) as `@modelcontextprotocol/sdk-shared` is now `@modelcontextprotocol/core`. Update imports: `@modelcontextprotocol/sdk-shared` → `@modelcontextprotocol/core`. The v1→v2 codemod emits the new name automatically. (The private internal barrel formerly named `@modelcontextprotocol/core` is now `@modelcontextprotocol/core-internal` and is not published.)
