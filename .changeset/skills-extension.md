---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

The MCP Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) as a pair of extensions.

`@modelcontextprotocol/server/ext/skills`: `new SkillsExtension(source)` in `ServerOptions.extensions` declares the extension and the `resources` capability, and serves `skills/list` and `skills/get` from a `SkillSource`, plus `resources/directory/read` (declared as `directoryRead`) when the source implements `readDirectory`. Entries are checked against the specification's structural rules before they are sent. Skill files stay ordinary resources; `skillResourceOf` computes the digest and size an entry lists for each.

`@modelcontextprotocol/client/ext/skills`: `new SkillsClientExtension()` in `ClientOptions.extensions` wraps `list`, `get` and `readDirectory`, each refused unless the server declared support, and `read(skill, uri)`, which fetches a skill file and verifies it is listed and matches the entry's size and digest.

Wire types and zod schemas live at `@modelcontextprotocol/core-internal/ext/skills` and are re-exported from both subpaths.
