---
'@modelcontextprotocol/core': major
'@modelcontextprotocol/client': major
'@modelcontextprotocol/server': major
---

Hide wire-only protocol members from the public types. `resultType` (the 2026-07-28 result discrimination field) is no longer declared on any public result type — the wire schemas keep parsing it and the SDK consumes it internally; the reserved `_meta` envelope keys and the multi-round-trip retry fields (`inputResponses`, `requestState`) appear in no public params/result type. High-level client/server methods now return the named public result types (`Promise<CallToolResult>` etc.) instead of structurally inferred schema types. Task wire vocabulary stays importable but is marked `@deprecated` and excluded from the typed method maps: `RequestMethod`/`RequestTypeMap`/`ResultTypeMap`/`NotificationTypeMap` no longer offer `tasks/*` methods, and `callTool` is typed as plain `CallToolResult` (no task union). See docs/migration.md "Wire-only protocol members hidden from the public types".
