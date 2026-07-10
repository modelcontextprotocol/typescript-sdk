---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/server-legacy': minor
---

Resolve the spec and OAuth schema modules from `@modelcontextprotocol/core` at
runtime instead of inlining a copy into each package's bundle. `client`,
`server`, and `server-legacy` gain a runtime dependency on
`@modelcontextprotocol/core`, and their builds mark it external so the schema
definitions ship once instead of once per package. Public import paths and the
exported API are unchanged.
